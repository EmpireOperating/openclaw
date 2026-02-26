#!/bin/bash
# Install OpenResponses reliability systemd user timer and bootstrap env file.
#
# Usage:
#   scripts/setup-openresponses-reliability-monitor.sh
#   scripts/setup-openresponses-reliability-monitor.sh --no-start

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SYSTEMD_DIR="$HOME/.config/systemd/user"
CONFIG_DIR="$HOME/.config/openclaw"
ENV_FILE="$CONFIG_DIR/openresponses-tool-call-reliability.env"
START_TIMER=1

if [ "${1:-}" = "--no-start" ]; then
  START_TIMER=0
fi

mkdir -p "$SYSTEMD_DIR" "$CONFIG_DIR"

cp "$SCRIPT_DIR/systemd/openclaw-openresponses-reliability.service" "$SYSTEMD_DIR/"
cp "$SCRIPT_DIR/systemd/openclaw-openresponses-reliability.timer" "$SYSTEMD_DIR/"

if [ ! -f "$ENV_FILE" ]; then
  cat >"$ENV_FILE" <<EOF
# OpenResponses reliability monitor config.
# Required:
GATEWAY_TOKEN=REPLACE_ME

# Optional routing:
GATEWAY_URL=http://127.0.0.1:18789
AGENT_ID=main
OPENRESPONSES_MODEL=openclaw

# Optional thresholds:
WARN_RETRY_ATTEMPT_RATE_PCT=3
WARN_RETRY_FAIL_RATE_PCT=25
WARN_TEXT_BEFORE_TOOL_RATE_PCT=5
FAIL_ON_WARN=1

# Alert destinations:
# ALERT_NTFY_TOPIC=openclaw-alerts
# ALERT_WEBHOOK_URL=https://example.com/hook
# ALERT_WEBHOOK_BEARER_TOKEN=REPLACE_ME
# ALERT_PHONE=+1234567890

# Optional repo path override (default: \$HOME/openclaw):
OPENCLAW_REPO_DIR=$ROOT_DIR
EOF
  echo "Created $ENV_FILE (edit GATEWAY_TOKEN before enabling timer)."
fi

systemctl --user daemon-reload

if [ "$START_TIMER" -eq 1 ]; then
  if grep -q '^GATEWAY_TOKEN=REPLACE_ME$' "$ENV_FILE"; then
    echo "Refusing to start timer while GATEWAY_TOKEN=REPLACE_ME in $ENV_FILE"
    echo "Edit the env file, then run:"
    echo "  systemctl --user enable --now openclaw-openresponses-reliability.timer"
    exit 1
  fi
  systemctl --user enable --now openclaw-openresponses-reliability.timer
  echo "Timer enabled:"
  echo "  systemctl --user status openclaw-openresponses-reliability.timer"
else
  echo "Units installed but not started (--no-start)."
  echo "After editing $ENV_FILE, run:"
  echo "  systemctl --user enable --now openclaw-openresponses-reliability.timer"
fi
