#!/bin/bash
# Alert hook for OpenResponses tool-call reliability monitoring.
#
# Usage:
#   scripts/openresponses-tool-call-reliability-alert.sh "message"
#   echo "message" | scripts/openresponses-tool-call-reliability-alert.sh
#
# Optional env:
#   ALERT_TITLE="OpenResponses Tool-Call Reliability Alert"
#   ALERT_TAGS="warning,openclaw"
#   ALERT_PRIORITY="high"
#   ALERT_NTFY_TOPIC="openclaw-alerts"
#   ALERT_WEBHOOK_URL="https://example.com/hook"
#   ALERT_WEBHOOK_BEARER_TOKEN="secret"
#   ALERT_PHONE="+1234567890"

set -euo pipefail

ALERT_TITLE="${ALERT_TITLE:-OpenResponses Tool-Call Reliability Alert}"
ALERT_TAGS="${ALERT_TAGS:-warning,openclaw}"
ALERT_PRIORITY="${ALERT_PRIORITY:-high}"
ALERT_NTFY_TOPIC="${ALERT_NTFY_TOPIC:-}"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
ALERT_WEBHOOK_BEARER_TOKEN="${ALERT_WEBHOOK_BEARER_TOKEN:-}"
ALERT_PHONE="${ALERT_PHONE:-}"

if [ "$#" -gt 0 ]; then
  MESSAGE="$*"
else
  MESSAGE="$(cat)"
fi

if [ -z "$MESSAGE" ]; then
  echo "No alert message provided."
  exit 2
fi

TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
HOSTNAME_SHORT="$(hostname 2>/dev/null || echo unknown-host)"
FULL_MESSAGE="[$TIMESTAMP][$HOSTNAME_SHORT] $MESSAGE"

echo "$FULL_MESSAGE"

sent=0

if [ -n "$ALERT_NTFY_TOPIC" ]; then
  curl -sS -o /dev/null \
    -H "Title: $ALERT_TITLE" \
    -H "Priority: $ALERT_PRIORITY" \
    -H "Tags: $ALERT_TAGS" \
    -d "$FULL_MESSAGE" \
    "https://ntfy.sh/$ALERT_NTFY_TOPIC" || true
  sent=1
fi

if [ -n "$ALERT_WEBHOOK_URL" ]; then
  AUTH_HEADER=()
  if [ -n "$ALERT_WEBHOOK_BEARER_TOKEN" ]; then
    AUTH_HEADER=(-H "Authorization: Bearer $ALERT_WEBHOOK_BEARER_TOKEN")
  fi
  PAYLOAD="$(
    node -e '
const [title, message, priority, tags, timestamp, host] = process.argv.slice(1);
process.stdout.write(
  JSON.stringify({
    title,
    message,
    priority,
    tags,
    timestamp,
    host,
  }),
);
' "$ALERT_TITLE" "$MESSAGE" "$ALERT_PRIORITY" "$ALERT_TAGS" "$TIMESTAMP" "$HOSTNAME_SHORT"
  )"
  curl -sS -o /dev/null \
    -X POST \
    -H "Content-Type: application/json" \
    "${AUTH_HEADER[@]}" \
    -d "$PAYLOAD" \
    "$ALERT_WEBHOOK_URL" || true
  sent=1
fi

if [ -n "$ALERT_PHONE" ] && command -v openclaw >/dev/null 2>&1; then
  openclaw send --to "$ALERT_PHONE" --message "$FULL_MESSAGE" >/dev/null 2>&1 || true
  sent=1
fi

if [ "$sent" -eq 0 ]; then
  echo "No alert destination configured (ALERT_NTFY_TOPIC, ALERT_WEBHOOK_URL, ALERT_PHONE)."
fi
