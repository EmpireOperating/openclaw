#!/bin/bash
# Wrapper for scheduled OpenResponses reliability smoke checks.
# Runs the smoke script and emits alerts when it fails.
#
# Environment:
#   OPENRESPONSES_MONITOR_NO_ALERT=1  # disable alert hook on failure

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SMOKE_SCRIPT="$SCRIPT_DIR/openresponses-tool-call-reliability-smoke.sh"
ALERT_SCRIPT="$SCRIPT_DIR/openresponses-tool-call-reliability-alert.sh"
NO_ALERT="${OPENRESPONSES_MONITOR_NO_ALERT:-0}"

tmp_output="$(mktemp)"
cleanup() {
  rm -f "$tmp_output"
}
trap cleanup EXIT

set +e
"$SMOKE_SCRIPT" >"$tmp_output" 2>&1
status=$?
set -e

cat "$tmp_output"

if [ "$status" -eq 0 ]; then
  exit 0
fi

if [ "$NO_ALERT" = "1" ]; then
  exit "$status"
fi

summary="OpenResponses reliability monitor failed (exit=$status)."
output_tail="$(tail -n 40 "$tmp_output" | sed 's/[[:cntrl:]]//g')"
if [ -n "$output_tail" ]; then
  "$ALERT_SCRIPT" "$summary"$'\n'"$output_tail" || true
else
  "$ALERT_SCRIPT" "$summary" || true
fi

exit "$status"
