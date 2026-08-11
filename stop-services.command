#!/usr/bin/env bash

set -u
set -o pipefail

ROOT_DIR="$(cd "$(dirname "$0")" >/dev/null 2>&1 && pwd -P)"
RUNTIME_DIR="$ROOT_DIR/.local-data/runtime"
API_ENTRY="$ROOT_DIR/apps/api/dist/src/main.js"
WORKER_ENTRY="$ROOT_DIR/apps/api/dist/src/worker.js"
VITE_ENTRY="$ROOT_DIR/node_modules/vite/bin/vite.js"

API_PID_FILE="$RUNTIME_DIR/api.pid"
WORKER_PID_FILE="$RUNTIME_DIR/worker.pid"
WEB_PID_FILE="$RUNTIME_DIR/web.pid"

PROJECT_NAME="project-call-center"
ERRORS=0

log() {
  printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

process_matches() {
  local pid="$1"
  local marker="$2"
  local command_line

  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command_line" in
    *"$marker"*) return 0 ;;
    *) return 1 ;;
  esac
}

descendant_pids() {
  local parent_pid="$1"
  local child

  command -v pgrep >/dev/null 2>&1 || return
  for child in $(pgrep -P "$parent_pid" 2>/dev/null || true); do
    descendant_pids "$child"
    printf '%s\n' "$child"
  done
}

stop_process() {
  local label="$1"
  local pid_file="$2"
  local marker="$3"
  local pid=""
  local children=""
  local child
  local attempts=0

  if [ ! -f "$pid_file" ]; then
    log "$label 未由一键启动脚本运行。"
    return
  fi

  IFS= read -r pid < "$pid_file" || true
  case "$pid" in
    ''|*[!0-9]*)
      log "$label 的 PID 文件无效，已清理。"
      rm -f "$pid_file"
      return
      ;;
  esac

  if ! kill -0 "$pid" 2>/dev/null; then
    log "$label 已停止，清理过期 PID 文件。"
    rm -f "$pid_file"
    return
  fi

  if ! process_matches "$pid" "$marker"; then
    log "警告：$label 的 PID $pid 已属于其他进程，不会终止该进程。"
    rm -f "$pid_file"
    ERRORS=$((ERRORS + 1))
    return
  fi

  children="$(descendant_pids "$pid")"
  log "停止 ${label}（PID ${pid}）..."
  kill -TERM "$pid" 2>/dev/null || true
  for child in $children; do
    kill -TERM "$child" 2>/dev/null || true
  done

  while kill -0 "$pid" 2>/dev/null && [ "$attempts" -lt 20 ]; do
    sleep 1
    attempts=$((attempts + 1))
  done

  if kill -0 "$pid" 2>/dev/null; then
    log "$label 未在 20 秒内退出，发送 KILL。"
    kill -KILL "$pid" 2>/dev/null || true
  fi
  for child in $children; do
    if kill -0 "$child" 2>/dev/null; then
      kill -KILL "$child" 2>/dev/null || true
    fi
  done

  rm -f "$pid_file"
  log "$label 已停止。"
}

cd "$ROOT_DIR" || {
  printf '无法进入项目目录：%s\n' "$ROOT_DIR" >&2
  exit 1
}

stop_process "Web" "$WEB_PID_FILE" "$VITE_ENTRY"
stop_process "API" "$API_PID_FILE" "$API_ENTRY"
stop_process "Worker" "$WORKER_PID_FILE" "$WORKER_ENTRY"

if ! command -v docker >/dev/null 2>&1; then
  log "警告：找不到 Docker，无法停止 PostgreSQL。"
  ERRORS=$((ERRORS + 1))
elif ! docker info >/dev/null 2>&1; then
  log "警告：Docker 服务未运行；PostgreSQL 容器当前不可管理。"
  ERRORS=$((ERRORS + 1))
else
  POSTGRES_CONTAINER="$(docker compose --project-name "$PROJECT_NAME" --file "$ROOT_DIR/compose.yaml" ps -q postgres 2>/dev/null)"
  if [ -z "$POSTGRES_CONTAINER" ]; then
    log "PostgreSQL 容器不存在或已经停止。"
  else
    log "停止本项目 PostgreSQL（保留容器和数据卷）..."
    if docker compose --project-name "$PROJECT_NAME" --file "$ROOT_DIR/compose.yaml" \
      stop --timeout 30 postgres; then
      log "PostgreSQL 已停止，数据卷 project-call-center-postgres 保持不变。"
    else
      log "警告：PostgreSQL 停止失败，请检查 Docker 状态。"
      ERRORS=$((ERRORS + 1))
    fi
  fi
fi

if [ "$ERRORS" -ne 0 ]; then
  printf '\n服务关闭完成，但有 %s 项需要人工检查。\n' "$ERRORS" >&2
  exit 1
fi

printf '\n全部服务已关闭，数据库数据和本地日志均已保留。\n'
