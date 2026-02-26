---
summary: "Runbook for OpenResponses tool call reliability monitoring and alerting on Linux"
read_when:
  - Rolling out direct action tool call enforcement
  - Setting up smoke checks and alerts for /v1/responses reliability
title: "OpenResponses Reliability Monitoring"
---

# OpenResponses reliability monitoring

This runbook explains the full monitoring system for OpenResponses tool call reliability and provides copy paste commands any agent can run.

Related docs:

- [OpenResponses API](/gateway/openresponses-http-api)
- [Automation troubleshooting](/automation/troubleshooting)

## What this system checks

The monitor checks reliability for `POST /v1/responses` by sampling requests and comparing counter deltas from:

- `GET /v1/responses/diagnostics/tool-call-reliability`

It tracks:

- `toolChoiceRetryAttempted`
- `toolChoiceRetryFailed`
- `toolCallAfterTextDelta`

It warns and fails when configured thresholds are exceeded.

## System components

- Smoke runner:
  - `scripts/openresponses-tool-call-reliability-smoke.sh`
  - Sends a small prompt set and computes rates from diagnostics deltas.
- Monitor wrapper:
  - `scripts/openresponses-tool-call-reliability-monitor.sh`
  - Runs smoke and invokes alert hook on failure.
- Alert hook:
  - `scripts/openresponses-tool-call-reliability-alert.sh`
  - Sends alerts to ntfy, webhook, and optional OpenClaw phone message.
- Setup helper:
  - `scripts/setup-openresponses-reliability-monitor.sh`
  - Installs systemd user units and bootstraps env file.
- systemd units:
  - `scripts/systemd/openclaw-openresponses-reliability.service`
  - `scripts/systemd/openclaw-openresponses-reliability.timer`

Execution flow:

1. Timer fires every 10 minutes.
2. Service loads `~/.config/openclaw/openresponses-tool-call-reliability.env`.
3. Service runs the monitor wrapper.
4. Wrapper runs smoke.
5. On non zero exit, wrapper calls alert hook with summary + output tail.

## Prerequisites

- Gateway host has the OpenClaw repo checked out (for example `~/openclaw`).
- `gateway.http.endpoints.responses.enabled` is `true`.
- Valid Gateway token for the monitored instance.
- Optional but recommended during rollout:
  - `gateway.http.endpoints.responses.implicitToolChoiceRequiredForDirectAction: true`

## One time setup on Linux gateway host

```bash
cd ~/openclaw
git pull
chmod +x scripts/openresponses-tool-call-reliability-*.sh scripts/setup-openresponses-reliability-monitor.sh
scripts/setup-openresponses-reliability-monitor.sh --no-start
```

Edit env file:

```bash
$EDITOR ~/.config/openclaw/openresponses-tool-call-reliability.env
```

Minimum required env:

```bash
GATEWAY_TOKEN=YOUR_GATEWAY_TOKEN
```

Enable timer:

```bash
systemctl --user enable --now openclaw-openresponses-reliability.timer
```

## Manual run commands for agents

Run one smoke pass:

```bash
GATEWAY_TOKEN=YOUR_GATEWAY_TOKEN scripts/openresponses-tool-call-reliability-smoke.sh
```

Run full monitor path including alert hook logic:

```bash
GATEWAY_TOKEN=YOUR_GATEWAY_TOKEN scripts/openresponses-tool-call-reliability-monitor.sh
```

Run service once via systemd:

```bash
systemctl --user start openclaw-openresponses-reliability.service
```

Check status:

```bash
systemctl --user status openclaw-openresponses-reliability.timer
systemctl --user status openclaw-openresponses-reliability.service
```

Check logs:

```bash
journalctl --user -u openclaw-openresponses-reliability.service -n 120 --no-pager
```

Read raw diagnostics:

```bash
curl -sS \
  -H "Authorization: Bearer YOUR_GATEWAY_TOKEN" \
  http://127.0.0.1:18789/v1/responses/diagnostics/tool-call-reliability
```

## Environment file reference

`~/.config/openclaw/openresponses-tool-call-reliability.env`

Core:

- `GATEWAY_TOKEN` required
- `GATEWAY_URL` default `http://127.0.0.1:18789`
- `AGENT_ID` default `main`
- `OPENRESPONSES_MODEL` default `openclaw`

Thresholds:

- `WARN_RETRY_ATTEMPT_RATE_PCT` default `3`
- `WARN_RETRY_FAIL_RATE_PCT` default `25`
- `WARN_TEXT_BEFORE_TOOL_RATE_PCT` default `5`
- `FAIL_ON_WARN` default `1` (set `0` for report only mode)

Alert routing:

- `ALERT_NTFY_TOPIC`
- `ALERT_WEBHOOK_URL`
- `ALERT_WEBHOOK_BEARER_TOKEN`
- `ALERT_PHONE`

Path override:

- `OPENCLAW_REPO_DIR` default `~/openclaw`

## Suggested thresholds

Start with these warning thresholds:

- retry attempt rate > `3%`
- retry fail rate > `25%`
- text before tool rate > `5%`

Suggested critical thresholds:

- retry attempt rate > `7%`
- retry fail rate > `40%`
- text before tool rate > `10%`

Tune by baseline traffic and model mix.

## Rollback and stop commands

Stop and disable monitor timer:

```bash
systemctl --user disable --now openclaw-openresponses-reliability.timer
```

Disable direct action enforcement flag in Gateway config:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          implicitToolChoiceRequiredForDirectAction: false
        }
      }
    }
  }
}
```

## Troubleshooting

- `401` or `Unauthorized` in smoke output:
  - check `GATEWAY_TOKEN` and gateway auth mode
- `404` on `/v1/responses`:
  - set `gateway.http.endpoints.responses.enabled=true`
- `404` on diagnostics endpoint:
  - update gateway to a build that includes tool call reliability diagnostics
- Timer runs but no alerts:
  - set one of `ALERT_NTFY_TOPIC`, `ALERT_WEBHOOK_URL`, `ALERT_PHONE`

