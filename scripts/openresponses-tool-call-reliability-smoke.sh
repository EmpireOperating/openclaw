#!/bin/bash
# OpenResponses tool-call reliability smoke check.
#
# Usage:
#   GATEWAY_TOKEN=... scripts/openresponses-tool-call-reliability-smoke.sh
#
# Optional env:
#   GATEWAY_URL=http://127.0.0.1:18789
#   AGENT_ID=main
#   OPENRESPONSES_MODEL=openclaw
#   REQUEST_TIMEOUT_SECONDS=20
#   WARN_RETRY_ATTEMPT_RATE_PCT=3
#   WARN_RETRY_FAIL_RATE_PCT=25
#   WARN_TEXT_BEFORE_TOOL_RATE_PCT=5
#   FAIL_ON_WARN=1

set -euo pipefail

GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:18789}"
GATEWAY_TOKEN="${GATEWAY_TOKEN:-}"
AGENT_ID="${AGENT_ID:-main}"
OPENRESPONSES_MODEL="${OPENRESPONSES_MODEL:-openclaw}"
REQUEST_TIMEOUT_SECONDS="${REQUEST_TIMEOUT_SECONDS:-20}"
WARN_RETRY_ATTEMPT_RATE_PCT="${WARN_RETRY_ATTEMPT_RATE_PCT:-3}"
WARN_RETRY_FAIL_RATE_PCT="${WARN_RETRY_FAIL_RATE_PCT:-25}"
WARN_TEXT_BEFORE_TOOL_RATE_PCT="${WARN_TEXT_BEFORE_TOOL_RATE_PCT:-5}"
FAIL_ON_WARN="${FAIL_ON_WARN:-1}"

if [ -z "$GATEWAY_TOKEN" ]; then
  echo "GATEWAY_TOKEN is required."
  echo "Example: GATEWAY_TOKEN=secret scripts/openresponses-tool-call-reliability-smoke.sh"
  exit 2
fi

RESPONSES_URL="${GATEWAY_URL%/}/v1/responses"
DIAGNOSTICS_URL="${GATEWAY_URL%/}/v1/responses/diagnostics/tool-call-reliability"
REQUEST_COUNT=0

calc_pct() {
  local numerator="$1"
  local denominator="$2"
  if [ "$denominator" -le 0 ]; then
    echo "0.00"
    return
  fi
  awk "BEGIN { printf \"%.2f\", (100 * $numerator) / $denominator }"
}

fetch_metrics_json() {
  curl -sS --fail --max-time "$REQUEST_TIMEOUT_SECONDS" \
    -H "Authorization: Bearer $GATEWAY_TOKEN" \
    "$DIAGNOSTICS_URL"
}

extract_metric() {
  local json="$1"
  local key="$2"
  node -e '
const payload = JSON.parse(process.argv[1]);
const key = process.argv[2];
const value = payload?.metrics?.[key];
if (typeof value !== "number") {
  console.error(`missing numeric metrics.${key}`);
  process.exit(1);
}
process.stdout.write(String(value));
' "$json" "$key"
}

response_field() {
  local json="$1"
  local expr="$2"
  node -e '
const payload = JSON.parse(process.argv[1]);
const expr = process.argv[2];
const value =
  expr === "status" ? payload?.status :
  expr === "error.code" ? payload?.error?.code :
  expr === "output0.type" ? payload?.output?.[0]?.type :
  expr === "output0.name" ? payload?.output?.[0]?.name :
  undefined;
process.stdout.write(typeof value === "string" ? value : "");
' "$json" "$expr"
}

post_response() {
  local request_body="$1"
  local response
  response="$(curl -sS --max-time "$REQUEST_TIMEOUT_SECONDS" \
    -H "Authorization: Bearer $GATEWAY_TOKEN" \
    -H "Content-Type: application/json" \
    -H "x-openclaw-agent-id: $AGENT_ID" \
    -d "$request_body" \
    -w $'\n%{http_code}' \
    "$RESPONSES_URL")"

  local status="${response##*$'\n'}"
  local body="${response%$'\n'*}"
  REQUEST_COUNT=$((REQUEST_COUNT + 1))

  if [ "$status" -eq 404 ]; then
    echo "POST /v1/responses returned 404 (endpoint disabled or wrong route)."
    echo "Set gateway.http.endpoints.responses.enabled=true first."
    exit 1
  fi
  if [ "$status" -ge 500 ]; then
    echo "POST /v1/responses returned server error: $status"
    echo "$body"
    exit 1
  fi
  if [ "$status" -ne 200 ] && [ "$status" -ne 422 ]; then
    echo "POST /v1/responses returned unexpected status: $status"
    echo "$body"
    exit 1
  fi

  echo "$status"$'\n'"$body"
}

echo "Reading baseline diagnostics from: $DIAGNOSTICS_URL"
BEFORE_JSON="$(fetch_metrics_json)"
BEFORE_NOT_SAT="$(extract_metric "$BEFORE_JSON" "toolChoiceNotSatisfied")"
BEFORE_RETRY_ATTEMPTED="$(extract_metric "$BEFORE_JSON" "toolChoiceRetryAttempted")"
BEFORE_RETRY_SUCCEEDED="$(extract_metric "$BEFORE_JSON" "toolChoiceRetrySucceeded")"
BEFORE_RETRY_FAILED="$(extract_metric "$BEFORE_JSON" "toolChoiceRetryFailed")"
BEFORE_TEXT_BEFORE_TOOL="$(extract_metric "$BEFORE_JSON" "toolCallAfterTextDelta")"

echo "Running sample OpenResponses requests against: $RESPONSES_URL"

CONTROL_RESULT="$(post_response "$(cat <<JSON
{"model":"$OPENRESPONSES_MODEL","input":"What time is it right now?","tools":[{"type":"function","function":{"name":"get_time","description":"Get current time"}}]}
JSON
)")"
CONTROL_STATUS="${CONTROL_RESULT%%$'\n'*}"
CONTROL_BODY="${CONTROL_RESULT#*$'\n'}"
echo "1) Q&A with tool: HTTP $CONTROL_STATUS status=$(response_field "$CONTROL_BODY" "status")"

DIRECT_RESULT="$(post_response "$(cat <<JSON
{"model":"$OPENRESPONSES_MODEL","input":"do it","tools":[{"type":"function","function":{"name":"exec","description":"Run command"}}]}
JSON
)")"
DIRECT_STATUS="${DIRECT_RESULT%%$'\n'*}"
DIRECT_BODY="${DIRECT_RESULT#*$'\n'}"
echo "2) Direct action without tool_choice: HTTP $DIRECT_STATUS status=$(response_field "$DIRECT_BODY" "status") error=$(response_field "$DIRECT_BODY" "error.code")"

REQUIRED_RESULT="$(post_response "$(cat <<JSON
{"model":"$OPENRESPONSES_MODEL","input":"run this","tools":[{"type":"function","function":{"name":"exec","description":"Run command"}}],"tool_choice":"required"}
JSON
)")"
REQUIRED_STATUS="${REQUIRED_RESULT%%$'\n'*}"
REQUIRED_BODY="${REQUIRED_RESULT#*$'\n'}"
echo "3) Direct action with tool_choice=required: HTTP $REQUIRED_STATUS status=$(response_field "$REQUIRED_BODY" "status") error=$(response_field "$REQUIRED_BODY" "error.code")"

echo "Reading post-run diagnostics..."
AFTER_JSON="$(fetch_metrics_json)"
AFTER_NOT_SAT="$(extract_metric "$AFTER_JSON" "toolChoiceNotSatisfied")"
AFTER_RETRY_ATTEMPTED="$(extract_metric "$AFTER_JSON" "toolChoiceRetryAttempted")"
AFTER_RETRY_SUCCEEDED="$(extract_metric "$AFTER_JSON" "toolChoiceRetrySucceeded")"
AFTER_RETRY_FAILED="$(extract_metric "$AFTER_JSON" "toolChoiceRetryFailed")"
AFTER_TEXT_BEFORE_TOOL="$(extract_metric "$AFTER_JSON" "toolCallAfterTextDelta")"

DELTA_NOT_SAT=$((AFTER_NOT_SAT - BEFORE_NOT_SAT))
DELTA_RETRY_ATTEMPTED=$((AFTER_RETRY_ATTEMPTED - BEFORE_RETRY_ATTEMPTED))
DELTA_RETRY_SUCCEEDED=$((AFTER_RETRY_SUCCEEDED - BEFORE_RETRY_SUCCEEDED))
DELTA_RETRY_FAILED=$((AFTER_RETRY_FAILED - BEFORE_RETRY_FAILED))
DELTA_TEXT_BEFORE_TOOL=$((AFTER_TEXT_BEFORE_TOOL - BEFORE_TEXT_BEFORE_TOOL))

RETRY_ATTEMPT_RATE_PCT="$(calc_pct "$DELTA_RETRY_ATTEMPTED" "$REQUEST_COUNT")"
if [ "$DELTA_RETRY_ATTEMPTED" -gt 0 ]; then
  RETRY_FAIL_RATE_PCT="$(calc_pct "$DELTA_RETRY_FAILED" "$DELTA_RETRY_ATTEMPTED")"
else
  RETRY_FAIL_RATE_PCT="0.00"
fi
TEXT_BEFORE_TOOL_RATE_PCT="$(calc_pct "$DELTA_TEXT_BEFORE_TOOL" "$REQUEST_COUNT")"

echo
echo "Diagnostics delta (this run):"
echo "  toolChoiceNotSatisfied:        $DELTA_NOT_SAT"
echo "  toolChoiceRetryAttempted:      $DELTA_RETRY_ATTEMPTED"
echo "  toolChoiceRetrySucceeded:      $DELTA_RETRY_SUCCEEDED"
echo "  toolChoiceRetryFailed:         $DELTA_RETRY_FAILED"
echo "  toolCallAfterTextDelta:        $DELTA_TEXT_BEFORE_TOOL"
echo "  sampled requests:              $REQUEST_COUNT"
echo "  retry attempt rate:            ${RETRY_ATTEMPT_RATE_PCT}%"
echo "  retry fail rate:               ${RETRY_FAIL_RATE_PCT}%"
echo "  text-before-tool rate:         ${TEXT_BEFORE_TOOL_RATE_PCT}%"

warned=0
if awk "BEGIN { exit !($RETRY_ATTEMPT_RATE_PCT > $WARN_RETRY_ATTEMPT_RATE_PCT) }"; then
  echo "WARN: retry attempt rate ${RETRY_ATTEMPT_RATE_PCT}% > ${WARN_RETRY_ATTEMPT_RATE_PCT}%"
  warned=1
fi
if awk "BEGIN { exit !($RETRY_FAIL_RATE_PCT > $WARN_RETRY_FAIL_RATE_PCT) }"; then
  echo "WARN: retry fail rate ${RETRY_FAIL_RATE_PCT}% > ${WARN_RETRY_FAIL_RATE_PCT}%"
  warned=1
fi
if awk "BEGIN { exit !($TEXT_BEFORE_TOOL_RATE_PCT > $WARN_TEXT_BEFORE_TOOL_RATE_PCT) }"; then
  echo "WARN: text-before-tool rate ${TEXT_BEFORE_TOOL_RATE_PCT}% > ${WARN_TEXT_BEFORE_TOOL_RATE_PCT}%"
  warned=1
fi

if [ "$warned" -eq 1 ] && [ "$FAIL_ON_WARN" = "1" ]; then
  exit 1
fi

echo "Smoke check complete."
