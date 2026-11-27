#!/bin/bash
# wactl schedule tick — cron entrypoint, runs every minute as root.
#
# For each instance in instances.json, asks the Node `due` helper which schedules
# should fire this minute (cron cadence or a pending .trigger) and launches the
# runner for each. A single shared cron drop-in drives all instances — no
# per-schedule crontab writes (see docs/scheduled-messages-spec.md §3).
set -euo pipefail
export TZ="${TZ:-Asia/Kolkata}"  # evaluate cron cadence in IST

INSTALL_DIR="${INSTALL_DIR:-/opt/wactl}"
INSTANCES="$INSTALL_DIR/instances.json"
DUE="$INSTALL_DIR/server/dist/schedules/due.js"
WATCH_POLL="$INSTALL_DIR/server/dist/schedules/watch-poll.js"

[ -f "$INSTANCES" ] || exit 0
[ -f "$DUE" ] || exit 0

for inst in $(jq -r '.instances | keys[]' "$INSTANCES"); do
  env_file="$INSTALL_DIR/instances/$inst/.env"
  [ -f "$env_file" ] || continue
  data_dir="$(grep -E '^DATA_DIR=' "$env_file" | head -1 | cut -d= -f2-)"
  bridge_port="$(grep -E '^BRIDGE_PORT=' "$env_file" | head -1 | cut -d= -f2-)"
  [ -n "$data_dir" ] || continue
  [ -d "$data_dir/schedules" ] || continue

  # due.js emits "<event> <slug>" (cron|compact|reset); watch-poll.js emits
  # "watch <slug>" for watches with new inbound. Fire each in the background;
  # per-schedule flock (in the runner) prevents overlap of the SAME schedule.
  {
    node "$DUE" "$data_dir" 2>/dev/null
    [ -f "$WATCH_POLL" ] && node "$WATCH_POLL" "$data_dir" "${bridge_port:-4000}" 2>/dev/null
  } | while read -r event slug; do
    [ -n "$slug" ] || continue
    "$INSTALL_DIR/scripts/schedule-run.sh" "$inst" "$slug" "$event" >/dev/null 2>&1 &
  done
done

wait
