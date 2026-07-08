#!/bin/bash
# wactl schedule runner — executes ONE scheduled trigger for one schedule.
#
#   schedule-run.sh <instance> <slug> <event> [payloadFile]
#
# Invoked by schedule-tick.sh (cron) or manually. It runs the Node runner as the
# unprivileged wactl user, under a per-schedule flock (so cron / Telegram / watch
# triggers for the same schedule serialize instead of forking the session), and
# ntfys on failure. dryRun / maxMsgs / recipient-pinning enforcement all live
# server-side and in the runner — this script is just the sandboxed launcher.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/wactl}"
RUN_AS="${SCHEDULE_RUN_AS:-wactl}"

instance="${1:?usage: schedule-run.sh <instance> <slug> <event> [payloadFile]}"
slug="${2:?slug required}"
event="${3:-cron}"
payload="${4:-}"

ENV_FILE="$INSTALL_DIR/instances/$instance/.env"
[ -f "$ENV_FILE" ] || { echo "no .env for instance '$instance'" >&2; exit 1; }

# Read only the vars we need (don't source the whole .env into our shell).
get() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2-; }
DATA_DIR="$(get DATA_DIR)"
MCP_PORT="$(get MCP_PORT)"
MCP_API_KEY="$(get MCP_API_KEY)"
BRIDGE_PORT="$(get BRIDGE_PORT)"               # watch runs read inbound from the bridge
ANTHROPIC_API_KEY="$(get ANTHROPIC_API_KEY)"   # runner auth: key takes precedence over any login
ANTHROPIC_BASE_URL="$(get ANTHROPIC_BASE_URL)" # gateway (e.g. Azure Foundry) — takes precedence when set
ANTHROPIC_AUTH_TOKEN="$(get ANTHROPIC_AUTH_TOKEN)" # Bearer token for the gateway
SCHEDULE_COMPACT_TOKEN_THRESHOLD="$(get SCHEDULE_COMPACT_TOKEN_THRESHOLD)"
CLAUDE_BIN="$(get CLAUDE_BIN)"; CLAUDE_BIN="${CLAUDE_BIN:-claude}"  # abs path (wactl user may lack root's PATH)
NTFY_TOPIC="$(get NTFY_TOPIC)"
NTFY_SERVER="$(get NTFY_SERVER)"; NTFY_SERVER="${NTFY_SERVER:-https://ntfy.sh}"

RUNNER="$INSTALL_DIR/server/dist/schedules/runner.js"
LOCK="$DATA_DIR/schedules/$slug/.lock"

# Failure ntfy — same shell pattern as upstream-watch.sh.
notify() {
  [ -n "$NTFY_TOPIC" ] || return 0
  curl -s --max-time 10 \
    -H "Title: wactl schedule: $slug" -H "Priority: high" -H "Tags: warning" \
    -d "$1" "$NTFY_SERVER/$NTFY_TOPIC" >/dev/null 2>&1 || true
}

# Preflight — fail loud, not cryptic.
[ -n "$DATA_DIR" ] || { echo "DATA_DIR unset for '$instance'" >&2; exit 1; }
[ -f "$RUNNER" ] || { echo "runner not built: $RUNNER (run npm run build)" >&2; exit 1; }
if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1; then
  notify "claude CLI not found on host — schedule '$slug' cannot run"
  echo "claude CLI not found" >&2; exit 1
fi

# Runner auth. Pass each credential into the run env only when set — an empty
# value would make claude treat auth as configured-but-invalid. A gateway
# (ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN, e.g. Azure Foundry) takes
# precedence; otherwise ANTHROPIC_API_KEY; otherwise ambient login (dev).
# CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is always on: it drops the advisor-tool
# anthropic-beta header that stricter gateways (Azure) reject, and cuts telemetry.
run_env=(
  DATA_DIR="$DATA_DIR"
  MCP_PORT="$MCP_PORT"
  MCP_API_KEY="$MCP_API_KEY"
  BRIDGE_PORT="${BRIDGE_PORT:-4000}"
  CLAUDE_BIN="$CLAUDE_BIN"
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
  SCHEDULE_COMPACT_TOKEN_THRESHOLD="${SCHEDULE_COMPACT_TOKEN_THRESHOLD:-450000}"
)
if [ -n "$ANTHROPIC_BASE_URL" ]; then
  run_env+=(ANTHROPIC_BASE_URL="$ANTHROPIC_BASE_URL")
fi
if [ -n "$ANTHROPIC_AUTH_TOKEN" ]; then
  run_env+=(ANTHROPIC_AUTH_TOKEN="$ANTHROPIC_AUTH_TOKEN")
fi
if [ -n "$ANTHROPIC_API_KEY" ]; then
  run_env+=(ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY")
fi

# Drop to the wactl user if it exists and we aren't already it.
sudo_prefix=()
if [ "$(id -un)" != "$RUN_AS" ] && id "$RUN_AS" >/dev/null 2>&1; then
  sudo_prefix=(sudo -u "$RUN_AS")
fi

# flock -w 300: bounded wait so a hung run can't wedge the schedule forever.
if ! "${sudo_prefix[@]}" env "${run_env[@]}" \
      flock -w 300 "$LOCK" \
      node "$RUNNER" "$DATA_DIR" "$slug" "$event" ${payload:+"$payload"}; then
  notify "schedule '$slug' run failed ($event) — check log.md; a message may or may not have been sent"
  exit 1
fi
