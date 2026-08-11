#!/usr/bin/env bash

set -u
set -o pipefail

ROOT_DIR="$(cd "$(dirname "$0")" >/dev/null 2>&1 && pwd -P)"
RUNTIME_DIR="$ROOT_DIR/.local-data/runtime"
LOG_DIR="$ROOT_DIR/.local-data/logs"
LOCK_DIR="$RUNTIME_DIR/start.lock"
API_ENV="$ROOT_DIR/apps/api/.env"
API_ENTRY="$ROOT_DIR/apps/api/dist/src/main.js"
WORKER_ENTRY="$ROOT_DIR/apps/api/dist/src/worker.js"
WEB_ROOT="$ROOT_DIR/apps/web"
VITE_ENTRY="$ROOT_DIR/node_modules/vite/bin/vite.js"

API_PID_FILE="$RUNTIME_DIR/api.pid"
WORKER_PID_FILE="$RUNTIME_DIR/worker.pid"
WEB_PID_FILE="$RUNTIME_DIR/web.pid"

API_LOG="$LOG_DIR/api.log"
WORKER_LOG="$LOG_DIR/worker.log"
WEB_LOG="$LOG_DIR/web.log"

PROJECT_NAME="project-call-center"
WEB_PORT=5173
API_PORT=8800

STARTED_API=0
STARTED_WORKER=0
STARTED_WEB=0
STARTED_POSTGRES=0
LOCK_HELD=0
MANAGED_PID=""

log() {
  printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

remove_lock() {
  if [ "$LOCK_HELD" -eq 1 ]; then
    rm -f "$LOCK_DIR/pid"
    rmdir "$LOCK_DIR" 2>/dev/null || true
    LOCK_HELD=0
  fi
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

read_managed_pid() {
  local pid_file="$1"
  local marker="$2"
  local pid=""

  MANAGED_PID=""
  [ -f "$pid_file" ] || return 1
  IFS= read -r pid < "$pid_file" || true

  case "$pid" in
    ''|*[!0-9]*)
      rm -f "$pid_file"
      return 1
      ;;
  esac

  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$pid_file"
    return 1
  fi

  if ! process_matches "$pid" "$marker"; then
    log "警告：$pid_file 中的 PID 已属于其他进程，已忽略该记录。"
    rm -f "$pid_file"
    return 1
  fi

  MANAGED_PID="$pid"
  return 0
}

terminate_started_process() {
  local pid_file="$1"
  local marker="$2"
  local label="$3"
  local pid
  local attempts=0

  if ! read_managed_pid "$pid_file" "$marker"; then
    return
  fi
  pid="$MANAGED_PID"
  log "回滚本次启动的 ${label}（PID ${pid}）..."
  kill -TERM "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null && [ "$attempts" -lt 15 ]; do
    sleep 1
    attempts=$((attempts + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
}

rollback() {
  if [ "$STARTED_WEB" -eq 1 ]; then
    terminate_started_process "$WEB_PID_FILE" "$VITE_ENTRY" "Web"
  fi
  if [ "$STARTED_API" -eq 1 ]; then
    terminate_started_process "$API_PID_FILE" "$API_ENTRY" "API"
  fi
  if [ "$STARTED_WORKER" -eq 1 ]; then
    terminate_started_process "$WORKER_PID_FILE" "$WORKER_ENTRY" "Worker"
  fi
  if [ "$STARTED_POSTGRES" -eq 1 ]; then
    log "回滚本次启动的 PostgreSQL..."
    docker compose --project-name "$PROJECT_NAME" --file "$ROOT_DIR/compose.yaml" \
      stop --timeout 30 postgres >/dev/null 2>&1 || true
  fi
}

fail() {
  printf '\n启动失败：%s\n' "$*" >&2
  rollback
  printf '日志目录：%s\n' "$LOG_DIR" >&2
  exit 1
}

handle_interrupt() {
  printf '\n收到终止信号，正在回滚本次启动...\n' >&2
  rollback
  exit 130
}

acquire_lock() {
  local lock_pid=""

  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    LOCK_HELD=1
    return
  fi

  if [ -f "$LOCK_DIR/pid" ]; then
    IFS= read -r lock_pid < "$LOCK_DIR/pid" || true
  fi
  case "$lock_pid" in
    ''|*[!0-9]*) lock_pid="" ;;
  esac

  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    fail "另一个启动程序正在运行（PID ${lock_pid}），请等待它完成。"
  fi

  rm -f "$LOCK_DIR/pid"
  rmdir "$LOCK_DIR" 2>/dev/null || fail "无法清理过期启动锁：$LOCK_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null || fail "无法创建启动锁：$LOCK_DIR"
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
  LOCK_HELD=1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少命令 $1。"
}

port_owner_pids() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u
}

ensure_port_available() {
  local port="$1"
  local label="$2"
  local owners

  owners="$(port_owner_pids "$port")"
  if [ -n "$owners" ]; then
    printf '\n%s 端口 %s 已被以下进程占用：\n' "$label" "$port" >&2
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2 || true
    fail "请先关闭占用端口 $port 的进程；脚本不会终止未由本项目记录的进程。"
  fi
}

wait_for_postgres() {
  local container_id
  local state=""
  local attempts=0

  container_id="$(docker compose --project-name "$PROJECT_NAME" --file "$ROOT_DIR/compose.yaml" ps -q postgres 2>/dev/null)"
  [ -n "$container_id" ] || return 1

  while [ "$attempts" -lt 90 ]; do
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
    if [ "$state" = "healthy" ]; then
      return 0
    fi
    if [ "$state" = "exited" ] || [ "$state" = "dead" ]; then
      return 1
    fi
    sleep 1
    attempts=$((attempts + 1))
  done
  return 1
}

start_process() {
  local label="$1"
  local pid_file="$2"
  local log_file="$3"
  local marker="$4"
  shift 4
  local pid

  log "启动 $label..."
  if [ -f "$log_file" ]; then
    mv -f "$log_file" "$log_file.previous"
  fi
  printf '\n[%s] ===== 启动 %s =====\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$label" >> "$log_file"
  (
    cd "$ROOT_DIR" || exit 1
    exec nohup "$@" >> "$log_file" 2>&1
  ) &
  pid=$!
  printf '%s\n' "$pid" > "$pid_file"
  disown "$pid" 2>/dev/null || true

  sleep 1
  if ! kill -0 "$pid" 2>/dev/null || ! process_matches "$pid" "$marker"; then
    tail -n 30 "$log_file" >&2 || true
    rm -f "$pid_file"
    return 1
  fi
  MANAGED_PID="$pid"
  return 0
}

wait_for_http() {
  local url="$1"
  local pid_file="$2"
  local marker="$3"
  local timeout="$4"
  local attempts=0

  while [ "$attempts" -lt "$timeout" ]; do
    if curl --fail --silent --show-error --connect-timeout 1 --max-time 3 "$url" >/dev/null 2>&1; then
      return 0
    fi
    if ! read_managed_pid "$pid_file" "$marker"; then
      return 1
    fi
    sleep 1
    attempts=$((attempts + 1))
  done
  return 1
}

wait_for_worker() {
  local timeout="$1"
  local attempts=0

  while [ "$attempts" -lt "$timeout" ]; do
    if grep -F "Call reconciliation worker started" "$WORKER_LOG" >/dev/null 2>&1; then
      return 0
    fi
    if ! read_managed_pid "$WORKER_PID_FILE" "$WORKER_ENTRY"; then
      return 1
    fi
    sleep 1
    attempts=$((attempts + 1))
  done
  return 1
}

local_ip() {
  local interface=""
  local address=""

  if command -v route >/dev/null 2>&1 && command -v ipconfig >/dev/null 2>&1; then
    interface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
    if [ -n "$interface" ]; then
      address="$(ipconfig getifaddr "$interface" 2>/dev/null || true)"
    fi
  elif command -v hostname >/dev/null 2>&1; then
    address="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  printf '%s' "$address"
}

mkdir -p "$RUNTIME_DIR" "$LOG_DIR" || {
  printf '无法创建本地运行目录：%s\n' "$RUNTIME_DIR" >&2
  exit 1
}
umask 077
trap remove_lock EXIT
trap handle_interrupt INT TERM
acquire_lock

cd "$ROOT_DIR" || fail "无法进入项目目录：$ROOT_DIR"

log "检查本机运行环境..."
require_command node
require_command npm
require_command docker
require_command curl
require_command lsof

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) fail "无法读取 Node.js 版本。" ;;
esac
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "需要 Node.js 22 或更高版本，当前版本为 $(node --version 2>/dev/null || printf '未知')。"
fi

docker compose version >/dev/null 2>&1 || fail "当前 Docker 不支持 docker compose。"
docker info >/dev/null 2>&1 || fail "Docker 服务未运行，请先启动 Docker Desktop。"
[ -f "$API_ENV" ] || fail "缺少 ${API_ENV}，请先从 apps/api/.env.example 创建并填写开发配置。"
[ -f "$ROOT_DIR/package-lock.json" ] || fail "缺少 package-lock.json。"

if [ ! -x "$ROOT_DIR/node_modules/.bin/nest" ] || [ ! -f "$VITE_ENTRY" ]; then
  log "首次运行或依赖不完整，正在安装 npm 依赖..."
  npm install || fail "npm 依赖安装失败。"
fi

API_PORT_VALUE="$(sed -n 's/^API_PORT=//p' "$API_ENV" | tail -n 1 | tr -d '[:space:]')"
if [ -n "$API_PORT_VALUE" ]; then
  case "$API_PORT_VALUE" in
    *[!0-9]*) fail "apps/api/.env 中的 API_PORT 必须是数字。" ;;
    *) API_PORT="$API_PORT_VALUE" ;;
  esac
fi
API_HEALTH_URL="http://127.0.0.1:$API_PORT/api/v1/health"
WEB_URL="http://127.0.0.1:$WEB_PORT/"

API_ALREADY_RUNNING=0
WORKER_ALREADY_RUNNING=0
WEB_ALREADY_RUNNING=0

if read_managed_pid "$API_PID_FILE" "$API_ENTRY"; then
  API_ALREADY_RUNNING=1
  log "API 已在运行（PID ${MANAGED_PID}）。"
else
  ensure_port_available "$API_PORT" "API"
fi

if read_managed_pid "$WORKER_PID_FILE" "$WORKER_ENTRY"; then
  WORKER_ALREADY_RUNNING=1
  log "Worker 已在运行（PID ${MANAGED_PID}）。"
elif pgrep -f "$WORKER_ENTRY" >/dev/null 2>&1; then
  fail "检测到未由 PID 文件记录的本项目 Worker；请先确认并手工关闭，避免重复对账。"
fi

if read_managed_pid "$WEB_PID_FILE" "$VITE_ENTRY"; then
  WEB_ALREADY_RUNNING=1
  log "Web 已在运行（PID ${MANAGED_PID}）。"
else
  ensure_port_available "$WEB_PORT" "Web"
fi

POSTGRES_WAS_RUNNING=0
POSTGRES_CONTAINER="$(docker compose --project-name "$PROJECT_NAME" --file "$ROOT_DIR/compose.yaml" ps -q postgres 2>/dev/null)"
if [ -n "$POSTGRES_CONTAINER" ] && [ "$(docker inspect --format '{{.State.Running}}' "$POSTGRES_CONTAINER" 2>/dev/null || true)" = "true" ]; then
  POSTGRES_WAS_RUNNING=1
fi

log "启动 PostgreSQL..."
docker compose --project-name "$PROJECT_NAME" --file "$ROOT_DIR/compose.yaml" up -d postgres \
  || fail "PostgreSQL 容器启动失败。"
if [ "$POSTGRES_WAS_RUNNING" -eq 0 ]; then
  STARTED_POSTGRES=1
fi
log "等待 PostgreSQL 健康检查..."
wait_for_postgres || fail "PostgreSQL 未在 90 秒内进入 healthy 状态，请查看 docker compose logs postgres。"

if [ "$API_ALREADY_RUNNING" -eq 0 ] || [ "$WORKER_ALREADY_RUNNING" -eq 0 ]; then
  log "生成 Prisma 客户端..."
  npm run db:generate || fail "Prisma 客户端生成失败。"
  log "执行数据库迁移（不会自动导入种子数据）..."
  npm run db:migrate || fail "数据库迁移失败。"
  log "构建最新 API 与 Worker..."
  npm run build --workspace @call-center/api || fail "API 构建失败。"
  [ -f "$API_ENTRY" ] && [ -f "$WORKER_ENTRY" ] || fail "API 构建产物不完整。"
fi

NODE_BIN="$(command -v node)"

if [ "$API_ALREADY_RUNNING" -eq 0 ]; then
  start_process "API" "$API_PID_FILE" "$API_LOG" "$API_ENTRY" \
    "$NODE_BIN" "--env-file=$API_ENV" "$API_ENTRY" || fail "API 进程启动失败。"
  STARTED_API=1
fi
log "等待 API 健康检查..."
if ! wait_for_http "$API_HEALTH_URL" "$API_PID_FILE" "$API_ENTRY" 180; then
  tail -n 50 "$API_LOG" >&2 || true
  fail "API 未在 180 秒内通过健康检查：$API_HEALTH_URL"
fi

if [ "$WORKER_ALREADY_RUNNING" -eq 0 ]; then
  start_process "Worker" "$WORKER_PID_FILE" "$WORKER_LOG" "$WORKER_ENTRY" \
    "$NODE_BIN" "--env-file=$API_ENV" "$WORKER_ENTRY" || fail "Worker 进程启动失败。"
  STARTED_WORKER=1
fi
log "等待 Worker 完成初始化..."
if ! wait_for_worker 180; then
  tail -n 50 "$WORKER_LOG" >&2 || true
  fail "Worker 未在 180 秒内完成初始化。"
fi

if [ "$WEB_ALREADY_RUNNING" -eq 0 ]; then
  start_process "Web" "$WEB_PID_FILE" "$WEB_LOG" "$VITE_ENTRY" \
    env "VITE_API_PROXY_TARGET=http://127.0.0.1:$API_PORT" \
    "$NODE_BIN" "$VITE_ENTRY" "$WEB_ROOT" --host 0.0.0.0 --port "$WEB_PORT" --strictPort \
    || fail "Web 进程启动失败。"
  STARTED_WEB=1
fi
log "等待 Web 可访问..."
if ! wait_for_http "$WEB_URL" "$WEB_PID_FILE" "$VITE_ENTRY" 90; then
  tail -n 50 "$WEB_LOG" >&2 || true
  fail "Web 未在 90 秒内可访问：$WEB_URL"
fi

LAN_IP="$(local_ip)"
printf '\n全部服务已启动。\n'
printf 'Web：     http://localhost:%s/\n' "$WEB_PORT"
printf 'API：     http://localhost:%s/api/v1/\n' "$API_PORT"
printf '健康检查：%s\n' "$API_HEALTH_URL"
if [ -n "$LAN_IP" ]; then
  printf '局域网 Web：http://%s:%s/\n' "$LAN_IP" "$WEB_PORT"
  printf '局域网 API：http://%s:%s/api/v1/\n' "$LAN_IP" "$API_PORT"
fi
printf '日志目录：%s\n' "$LOG_DIR"
printf '关闭服务：%s\n' "$ROOT_DIR/stop-services.command"
