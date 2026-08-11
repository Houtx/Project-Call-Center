#!/usr/bin/env bash
set -euo pipefail

API_BASE_URL="${API_BASE_URL:-http://127.0.0.1:8800/api/v1}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:?Set ADMIN_PASSWORD for the test administrator}"
TEST_AGENT_PASSWORD="${TEST_AGENT_PASSWORD:?Set TEST_AGENT_PASSWORD for the temporary test agent}"
RUN_ID="$(date +%s)"
SUFFIX="$(printf '%08d' "$((RUN_ID % 100000000))")"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
trap 'echo "Smoke test failed at line ${LINENO}" >&2' ERR

json_post() {
  local path="$1"
  local token="$2"
  local key="$3"
  local body="$4"
  curl -fsS \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${token}" \
    -H "Idempotency-Key: ${key}" \
    -d "$body" \
    "${API_BASE_URL}${path}"
}

health="$(curl -fsS "${API_BASE_URL}/health")"
jq -e '.status == "ok" and .database == "up"' <<<"$health" >/dev/null

admin_session="$(curl -fsS \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg username "$ADMIN_USERNAME" --arg password "$ADMIN_PASSWORD" '{username:$username,password:$password}')" \
  "${API_BASE_URL}/auth/login")"
admin_token="$(jq -er '.accessToken' <<<"$admin_session")"

agent_username="e2e_${RUN_ID}"
agent_password="$TEST_AGENT_PASSWORD"
agent="$(json_post '/agents' "$admin_token" "agent-${RUN_ID}" \
  "$(jq -nc --arg username "$agent_username" --arg displayName "验收坐席 ${RUN_ID}" --arg password "$agent_password" \
    '{username:$username,displayName:$displayName,password:$password}')")"
agent_id="$(jq -er '.id' <<<"$agent")"

batch="$(json_post '/batches' "$admin_token" "batch-${RUN_ID}" \
  "$(jq -nc --arg name "验收批次 ${RUN_ID}" --arg code "E2E-${RUN_ID}" '{name:$name,code:$code,notes:"端到端验收"}')")"
batch_id="$(jq -er '.id' <<<"$batch")"

phone_connected="135${SUFFIX}"
phone_suppressed="136${SUFFIX}"
phone_imported="137${SUFFIX}"

customer_body="$(jq -nc --arg name "接通客户 ${RUN_ID}" --arg phone "$phone_connected" --arg batchId "$batch_id" \
  '{name:$name,phone:$phone,batchId:$batchId,province:"江苏",city:"南京",carrier:"中国移动",tags:["验收"]}')"
customer="$(json_post '/customers' "$admin_token" "customer-${RUN_ID}" "$customer_body")"
customer_id="$(jq -er '.id' <<<"$customer")"
customer_version="$(jq -er '.version' <<<"$customer")"

customer_replay="$(json_post '/customers' "$admin_token" "customer-${RUN_ID}" "$customer_body")"
test "$(jq -er '.id' <<<"$customer_replay")" = "$customer_id"

updated_customer="$(curl -fsS -X PATCH \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${admin_token}" \
  -H "Idempotency-Key: customer-update-${RUN_ID}" \
  -d "$(jq -nc --argjson version "$customer_version" '{version:$version,notes:"已通过幂等更新验收"}')" \
  "${API_BASE_URL}/customers/${customer_id}")"
jq -e --argjson expected "$((customer_version + 1))" '.version == $expected' <<<"$updated_customer" >/dev/null

json_post '/assignments' "$admin_token" "assign-${RUN_ID}" \
  "$(jq -nc --arg customerId "$customer_id" --arg agentId "$agent_id" '{customerIds:[$customerId],agentId:$agentId}')" \
  | jq -e '.assigned == 1' >/dev/null

model_body="$(jq -nc --arg manufacturer "E2E-${RUN_ID}" '{manufacturer:$manufacturer,model:"Validated Phone",androidSdk:35,notes:"automated smoke test"}')"
curl -fsS \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${admin_token}" \
  -H "Idempotency-Key: model-${RUN_ID}" \
  -d "$model_body" \
  "${API_BASE_URL}/device-models" >/dev/null

policy="$(curl -fsS -H "Authorization: Bearer ${admin_token}" "${API_BASE_URL}/mobile-app-policy")"
minimum_version="$(jq -er '.minimumVersionCode' <<<"$policy")"
latest_version="$(jq -er '.latestVersionCode' <<<"$policy")"
max_call_attempts="$(jq -er '.maxCallAttempts' <<<"$policy")"
curl -fsS -X PATCH \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${admin_token}" \
  -H "Idempotency-Key: policy-${RUN_ID}" \
  -d "$(jq -nc --argjson minimum "$minimum_version" --argjson latest "$latest_version" --argjson maxAttempts "$max_call_attempts" \
    '{minimumVersionCode:$minimum,latestVersionCode:$latest,forceUpgrade:false,maxCallAttempts:$maxAttempts}')" \
  "${API_BASE_URL}/mobile-app-policy" | jq -e \
    ".forceUpgrade == false and .maxCallAttempts == ${max_call_attempts}" >/dev/null

agent_session_first="$(curl -fsS \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg username "$agent_username" --arg password "$agent_password" --arg installId "install-a-${RUN_ID}" --arg manufacturer "E2E-${RUN_ID}" \
    '{username:$username,password:$password,device:{installId:$installId,manufacturer:$manufacturer,model:"Validated Phone",androidVersion:"15",androidSdk:35,appVersion:"0.1.0",appVersionCode:1}}')" \
  "${API_BASE_URL}/auth/login")"
first_agent_token="$(jq -er '.accessToken' <<<"$agent_session_first")"
first_refresh_token="$(jq -er '.refreshToken' <<<"$agent_session_first")"

agent_session="$(curl -fsS \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg username "$agent_username" --arg password "$agent_password" --arg installId "install-b-${RUN_ID}" --arg manufacturer "E2E-${RUN_ID}" \
    '{username:$username,password:$password,device:{installId:$installId,manufacturer:$manufacturer,model:"Validated Phone",androidVersion:"15",androidSdk:35,appVersion:"0.1.0",appVersionCode:1}}')" \
  "${API_BASE_URL}/auth/login")"
agent_token="$(jq -er '.accessToken' <<<"$agent_session")"

first_status="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${first_agent_token}" "${API_BASE_URL}/mobile/bootstrap")"
test "$first_status" = "401"
first_refresh_status="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg refreshToken "$first_refresh_token" '{refreshToken:$refreshToken}')" \
  "${API_BASE_URL}/auth/refresh")"
test "$first_refresh_status" = "401"

curl -fsS \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${agent_token}" \
  -d '{"appVersion":"0.1.0","appVersionCode":1,"callPhonePermission":"GRANTED","callLogPermission":"GRANTED"}' \
  "${API_BASE_URL}/mobile/heartbeat" >/dev/null

bootstrap="$(curl -fsS -H "Authorization: Bearer ${agent_token}" "${API_BASE_URL}/mobile/bootstrap")"
jq -e '.device.compatible == true' <<<"$bootstrap" >/dev/null

sync="$(curl -fsS -H "Authorization: Bearer ${agent_token}" "${API_BASE_URL}/mobile/sync?cursor=0")"
assignment_id="$(jq -er --arg customerId "$customer_id" \
  '.changes[] | select(.operation == "UPSERT" and .assignment.customerId == $customerId) | .assignment.assignmentId' <<<"$sync")"
cursor_after_assign="$(jq -er '.cursor' <<<"$sync")"

revealed="$(curl -fsS -X POST -H "Authorization: Bearer ${agent_token}" \
  "${API_BASE_URL}/mobile/assignments/${assignment_id}/phone")"
jq -e --arg phone "+86${phone_connected}" '.phone == $phone' <<<"$revealed" >/dev/null

baseline_at="$(node -e 'process.stdout.write(new Date().toISOString())')"
attempt="$(curl -fsS \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${agent_token}" \
  -d "$(jq -nc --arg assignmentId "$assignment_id" --arg clientAttemptId "client-${RUN_ID}" --arg at "$baseline_at" \
    '{assignmentId:$assignmentId,clientAttemptId:$clientAttemptId,callLogBaselineId:"100",callLogBaselineAt:$at}')" \
  "${API_BASE_URL}/mobile/call-attempts")"
attempt_id="$(jq -er '.attemptId' <<<"$attempt")"

call_started_at="$(node -e 'process.stdout.write(new Date().toISOString())')"
call_ended_at="$(node -e 'process.stdout.write(new Date(Date.now()+42000).toISOString())')"
call_result_body="$(jq -nc --arg eventId "event-${RUN_ID}" --arg attemptId "$attempt_id" --arg startedAt "$call_started_at" --arg endedAt "$call_ended_at" \
  '{results:[{eventId:$eventId,attemptId:$attemptId,systemCallLogId:"101",systemCallStartedAt:$startedAt,systemCallEndedAt:$endedAt,durationSeconds:42,clientObservedAt:$endedAt}]}')"
result="$(curl -fsS \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${agent_token}" \
  -d "$call_result_body" \
  "${API_BASE_URL}/mobile/call-log-results:batch")"
jq -e '.accepted == 1 and .duplicates == 0' <<<"$result" >/dev/null

result_replay="$(curl -fsS \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${agent_token}" \
  -d "$call_result_body" \
  "${API_BASE_URL}/mobile/call-log-results:batch")"
jq -e '.accepted == 0 and .duplicates == 1' <<<"$result_replay" >/dev/null

sync_after_call="$(curl -fsS -H "Authorization: Bearer ${agent_token}" \
  "${API_BASE_URL}/mobile/sync?cursor=${cursor_after_assign}")"
jq -e --arg assignmentId "$assignment_id" \
  '.changes | any(.operation == "REMOVE" and .entityId == $assignmentId)' <<<"$sync_after_call" >/dev/null

suppressed_customer="$(json_post '/customers' "$admin_token" "suppressed-customer-${RUN_ID}" \
  "$(jq -nc --arg name "拒呼客户 ${RUN_ID}" --arg phone "$phone_suppressed" --arg batchId "$batch_id" \
    '{name:$name,phone:$phone,batchId:$batchId}')")"
suppressed_customer_id="$(jq -er '.id' <<<"$suppressed_customer")"
json_post '/assignments' "$admin_token" "suppressed-assign-${RUN_ID}" \
  "$(jq -nc --arg customerId "$suppressed_customer_id" --arg agentId "$agent_id" '{customerIds:[$customerId],agentId:$agentId}')" >/dev/null

suppression="$(json_post '/suppression' "$admin_token" "suppression-${RUN_ID}" \
  "$(jq -nc --arg phone "$phone_suppressed" '{phone:$phone,reason:"客户明确拒绝外呼"}')")"
jq -e '.withdrawnAssignments == 1' <<<"$suppression" >/dev/null

template_file="${TMP_DIR}/customer-import-template.xlsx"
curl -fsS \
  -H "Authorization: Bearer ${admin_token}" \
  -o "$template_file" \
  "${API_BASE_URL}/customers/import/template"
node - "$template_file" <<'NODE'
const ExcelJS = require('exceljs');

async function main() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(process.argv[2]);
  const worksheet = workbook.worksheets[0];
  const headers = worksheet.getRow(1).values.slice(1);
  if (headers.length !== 2 || headers[0] !== '姓名' || headers[1] !== '手机号') {
    throw new Error(`Unexpected import template headers: ${JSON.stringify(headers)}`);
  }
  if (worksheet.actualRowCount !== 1) {
    throw new Error(`Import template should be empty, got ${worksheet.actualRowCount - 1} data rows`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
NODE

csv_file="${TMP_DIR}/customers.csv"
printf '姓名,手机号\n新导入客户,%s\n重复客户,%s\n拒呼客户,%s\n错误客户,12345\n' \
  "$phone_imported" "$phone_connected" "$phone_suppressed" >"$csv_file"

preview="$(curl -fsS \
  -H "Authorization: Bearer ${admin_token}" \
  -H "Idempotency-Key: import-preview-${RUN_ID}" \
  -F "batchId=${batch_id}" \
  -F "file=@${csv_file}" \
  "${API_BASE_URL}/customers/import/preview")"
jq -e '.total == 4 and .newCount == 1 and .duplicateCount == 1 and .suppressedCount == 1 and .invalidCount == 1' \
  <<<"$preview" >/dev/null
import_id="$(jq -er '.importId' <<<"$preview")"

commit="$(json_post '/customers/import/commit' "$admin_token" "import-commit-${RUN_ID}" \
  "$(jq -nc --arg importId "$import_id" '{importId:$importId,duplicateMode:"SKIP"}')")"
jq -e '.created == 1 and .updated == 0 and .skipped == 3' <<<"$commit" >/dev/null

summary="$(curl -fsS -H "Authorization: Bearer ${admin_token}" \
  "${API_BASE_URL}/reports/summary?agentId=${agent_id}")"
jq -e '.attempts == 1 and .connected == 1 and .connectionRate == 1 and .totalDurationSeconds == 42' \
  <<<"$summary" >/dev/null

calls="$(curl -fsS -H "Authorization: Bearer ${admin_token}" \
  "${API_BASE_URL}/calls?agentId=${agent_id}&page=1&pageSize=20")"
jq -e --arg attemptId "$attempt_id" '.items | any(.attemptId == $attemptId and .status == "CONNECTED")' \
  <<<"$calls" >/dev/null

customer_detail="$(curl -fsS -H "Authorization: Bearer ${admin_token}" \
  "${API_BASE_URL}/customers/${customer_id}")"
jq -e '.assignmentHistory | any(.status == "COMPLETED")' <<<"$customer_detail" >/dev/null

json_post "/customers/${customer_id}/archive" "$admin_token" "archive-${RUN_ID}" '{}' >/dev/null
json_post "/customers/${customer_id}/erase" "$admin_token" "erase-${RUN_ID}" \
  "$(jq -nc --arg reason "端到端合规删除验收 ${RUN_ID}" '{reason:$reason}')" >/dev/null
erased_customer="$(curl -fsS -H "Authorization: Bearer ${admin_token}" \
  "${API_BASE_URL}/customers/${customer_id}")"
jq -e '.name == "已删除客户" and .phoneMasked == "***" and .erasedAt != null and (.assignmentHistory | length) > 0' \
  <<<"$erased_customer" >/dev/null

audits="$(curl -fsS -H "Authorization: Bearer ${admin_token}" \
  "${API_BASE_URL}/audit-events?page=1&pageSize=100&search=${RUN_ID}")"
jq -e '.total > 0' <<<"$audits" >/dev/null

jq -n \
  --arg runId "$RUN_ID" \
  --arg agentId "$agent_id" \
  --arg customerId "$customer_id" \
  --arg attemptId "$attempt_id" \
  --arg deviceId "$device_id" \
  --arg importId "$import_id" \
  '{ok:true,runId:$runId,agentId:$agentId,customerId:$customerId,attemptId:$attemptId,deviceId:$deviceId,importId:$importId}'
