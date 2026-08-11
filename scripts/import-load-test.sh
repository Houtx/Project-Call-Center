#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:8800/api/v1}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:?Set ADMIN_PASSWORD for the test administrator}"
IMPORT_COUNT="${IMPORT_COUNT:-100000}"

if [[ "${IMPORT_LOAD_TEST_CONFIRM:-}" != "$IMPORT_COUNT" ]]; then
  echo "This test persists ${IMPORT_COUNT} customers. Set IMPORT_LOAD_TEST_CONFIRM=${IMPORT_COUNT} to continue." >&2
  exit 2
fi
if (( IMPORT_COUNT < 1 || IMPORT_COUNT > 100000 )); then
  echo "IMPORT_COUNT must be between 1 and 100000" >&2
  exit 2
fi

load_tmp="$(mktemp -d)"
trap 'rm -rf -- "$load_tmp"' EXIT
trap 'echo "Import load test failed at line ${LINENO}" >&2' ERR

run_id="$(date +%s)"
run_slot="$((run_id % 1000))"
csv_file="${load_tmp}/customers-${run_id}.csv"
awk -v count="$IMPORT_COUNT" -v slot="$run_slot" 'BEGIN {
  print "姓名,手机号"
  for (i = 0; i < count; i++) {
    printf "压测客户%06d,188%03d%05d\n", i + 1, slot, i
  }
}' > "$csv_file"

admin_session="$(curl -fsS \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg username "$ADMIN_USERNAME" --arg password "$ADMIN_PASSWORD" '{username:$username,password:$password}')" \
  "${API_BASE_URL}/auth/login")"
admin_token="$(jq -er '.accessToken' <<<"$admin_session")"

batch="$(curl -fsS \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${admin_token}" \
  -H "Idempotency-Key: load-batch-${run_id}" \
  -d "$(jq -nc --arg name "导入压测 ${run_id}" --arg code "LOAD-${run_id}" '{name:$name,code:$code,notes:"批量导入容量验收"}')" \
  "${API_BASE_URL}/batches")"
batch_id="$(jq -er '.id' <<<"$batch")"

preview_started="$(date +%s)"
preview="$(curl -fsS \
  -H "Authorization: Bearer ${admin_token}" \
  -H "Idempotency-Key: load-preview-${run_id}" \
  -F "batchId=${batch_id}" \
  -F "file=@${csv_file}" \
  "${API_BASE_URL}/customers/import/preview")"
preview_seconds="$(( $(date +%s) - preview_started ))"
jq -e --argjson count "$IMPORT_COUNT" \
  '.total == $count and .newCount == $count and .duplicateCount == 0 and .invalidCount == 0 and .suppressedCount == 0' \
  <<<"$preview" >/dev/null
import_id="$(jq -er '.importId' <<<"$preview")"

commit_started="$(date +%s)"
commit="$(curl -fsS \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${admin_token}" \
  -H "Idempotency-Key: load-commit-${run_id}" \
  -d "$(jq -nc --arg importId "$import_id" '{importId:$importId,duplicateMode:"SKIP"}')" \
  "${API_BASE_URL}/customers/import/commit")"
commit_seconds="$(( $(date +%s) - commit_started ))"
jq -e --argjson count "$IMPORT_COUNT" '.created == $count and .updated == 0 and .skipped == 0' \
  <<<"$commit" >/dev/null

jq -n \
  --arg runId "$run_id" \
  --arg importId "$import_id" \
  --argjson rows "$IMPORT_COUNT" \
  --argjson previewSeconds "$preview_seconds" \
  --argjson commitSeconds "$commit_seconds" \
  '{ok:true,runId:$runId,importId:$importId,rows:$rows,previewSeconds:$previewSeconds,commitSeconds:$commitSeconds}'
