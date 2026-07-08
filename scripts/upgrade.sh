#!/bin/bash
# wactl upgrade — pull the latest code and rebuild BOTH the Go bridge and the
# TypeScript server, then restart every instance's services.
#
# The daily update-check.sh cron only rebuilds the bridge (it tracks whatsmeow).
# Server-side changes (MCP tools, admin, scheduled messages, wactl-telegram) need
# this. Safe to re-run; it fast-forwards git and rebuilds in place.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/wactl}"
INSTANCES_JSON="$INSTALL_DIR/instances.json"

echo "[wactl-upgrade] Pulling latest code in $INSTALL_DIR..."
git -C "$INSTALL_DIR" pull --ff-only

echo "[wactl-upgrade] Rebuilding Go bridge..."
( cd "$INSTALL_DIR/bridge" && CGO_ENABLED=1 go build -o wactl-bridge . )

echo "[wactl-upgrade] Rebuilding TypeScript server..."
( cd "$INSTALL_DIR/server" && npm ci --silent && npm run build )

# Refresh systemd units + schedule dir perms + claude path in each .env, without
# rewriting operator config. A full `install.sh <name>` re-run also does this;
# here we just restart with the freshly built code.
if [ -f "$INSTANCES_JSON" ]; then
  for inst in $(jq -r '.instances | keys[]' "$INSTANCES_JSON"); do
    echo "[wactl-upgrade] Restarting instance '$inst'..."
    systemctl restart "wactl-${inst}-bridge" "wactl-${inst}-server" 2>/dev/null || true
    systemctl restart "wactl-${inst}-telegram" 2>/dev/null || true
  done
fi

echo "[wactl-upgrade] Done. Verify: systemctl status wactl-<instance>-server"
