#!/bin/bash
# wactl auto-update check script (multi-instance)
# Called by cron daily at 3 AM (configurable)
# Fetches latest whatsmeow, rebuilds bridge, self-tests, and distributes
# the new binary to all instances

set -e

INSTALL_DIR="${INSTALL_DIR:-/opt/wactl}"
BRIDGE_DIR="$INSTALL_DIR/bridge"
INSTANCES_JSON="$INSTALL_DIR/instances.json"
LOG_PREFIX="[wactl-update $(date -Iseconds)]"
export PATH="$PATH:/usr/local/go/bin"

echo "$LOG_PREFIX Starting update check..."

# Ensure instances.json exists
if [ ! -f "$INSTANCES_JSON" ]; then
  echo "$LOG_PREFIX No instances.json found at $INSTANCES_JSON — nothing to update."
  exit 0
fi

# Record current version
CURRENT=$(grep 'go.mau.fi/whatsmeow' "$BRIDGE_DIR/go.mod" | awk '{print $2}')
echo "$LOG_PREFIX Current whatsmeow: $CURRENT"

# Check latest
cd "$BRIDGE_DIR"
cp go.mod go.mod.bak
cp go.sum go.sum.bak

GOFLAGS="-mod=mod" go get go.mau.fi/whatsmeow@latest 2>/dev/null
go mod tidy 2>/dev/null
LATEST=$(grep 'go.mau.fi/whatsmeow' "$BRIDGE_DIR/go.mod" | awk '{print $2}')
echo "$LOG_PREFIX Latest whatsmeow: $LATEST"

if [ "$CURRENT" = "$LATEST" ]; then
  echo "$LOG_PREFIX Already up to date."
  rm -f go.mod.bak go.sum.bak
  exit 0
fi

echo "$LOG_PREFIX Update available: $CURRENT → $LATEST"
echo "$LOG_PREFIX Building new binary..."

if ! CGO_ENABLED=1 go build -o wactl-bridge-new . 2>&1; then
  echo "$LOG_PREFIX Build failed, reverting..."
  mv go.mod.bak go.mod
  mv go.sum.bak go.sum
  # Notify all instances with ntfy configured about the build failure
  jq -r '.instances | to_entries[] | .key' "$INSTANCES_JSON" | while read -r INST; do
    INST_ENV="$INSTALL_DIR/instances/$INST/.env"
    if [ -f "$INST_ENV" ]; then
      NTFY=$(grep '^NTFY_TOPIC=' "$INST_ENV" 2>/dev/null | cut -d= -f2)
      NTFY_SRV=$(grep '^NTFY_SERVER=' "$INST_ENV" 2>/dev/null | cut -d= -f2-)
      NTFY_SRV="${NTFY_SRV:-https://ntfy.sh}"
      if [ -n "$NTFY" ]; then
        curl -s -d "Auto-update build to $LATEST failed. Manual review needed." \
          -H "Title: wactl — Auto-update Failed" -H "Priority: urgent" \
          "$NTFY_SRV/$NTFY" > /dev/null 2>&1 || true
      fi
    fi
  done
  exit 1
fi

# Self-test: start on temp port and check /status
# Use port 14099 (well above the instance port range) to avoid collisions
TEST_PORT=14099
TEST_DATA_DIR=$(mktemp -d "/tmp/wactl-test-XXXXXX")
echo "$LOG_PREFIX Self-testing on port $TEST_PORT..."
DATA_DIR="$TEST_DATA_DIR" BRIDGE_PORT=$TEST_PORT ./wactl-bridge-new &
TEST_PID=$!
sleep 5

TEST_RESULT=$(curl -s "http://127.0.0.1:$TEST_PORT/status" 2>/dev/null || echo "FAIL")
kill $TEST_PID 2>/dev/null
wait $TEST_PID 2>/dev/null || true

rm -rf "$TEST_DATA_DIR"

# A fresh binary with no session returns connected:false — that's fine.
# A valid JSON response with the "connected" key proves it started correctly.
if echo "$TEST_RESULT" | grep -q '"connected"'; then
  echo "$LOG_PREFIX Self-test PASSED"

  # Update the canonical binary in the bridge directory
  mv wactl-bridge-new wactl-bridge
  rm -f go.mod.bak go.sum.bak

  # Copy new binary to each instance and restart their bridge services
  INSTANCE_NAMES=$(jq -r '.instances | keys[]' "$INSTANCES_JSON")
  for INST in $INSTANCE_NAMES; do
    INST_DIR="$INSTALL_DIR/instances/$INST"
    if [ -d "$INST_DIR" ]; then
      echo "$LOG_PREFIX Updating instance '$INST'..."
      systemctl stop "wactl-${INST}-server" "wactl-${INST}-bridge" 2>/dev/null || true
      cp "$BRIDGE_DIR/wactl-bridge" "$INST_DIR/wactl-bridge"
      systemctl start "wactl-${INST}-bridge" "wactl-${INST}-server" 2>/dev/null || true
      echo "$LOG_PREFIX Instance '$INST' restarted."
    else
      echo "$LOG_PREFIX WARNING: Instance directory missing for '$INST', skipping."
    fi
  done

  echo "$LOG_PREFIX Updated all instances to $LATEST"

  # Notify all instances with ntfy configured about the successful update
  jq -r '.instances | to_entries[] | .key' "$INSTANCES_JSON" | while read -r INST; do
    INST_ENV="$INSTALL_DIR/instances/$INST/.env"
    if [ -f "$INST_ENV" ]; then
      NTFY=$(grep '^NTFY_TOPIC=' "$INST_ENV" 2>/dev/null | cut -d= -f2)
      NTFY_SRV=$(grep '^NTFY_SERVER=' "$INST_ENV" 2>/dev/null | cut -d= -f2-)
      NTFY_SRV="${NTFY_SRV:-https://ntfy.sh}"
      if [ -n "$NTFY" ]; then
        curl -s -d "whatsmeow updated to $LATEST. Bridge restarted." \
          -H "Title: wactl — Updated" -H "Priority: default" \
          "$NTFY_SRV/$NTFY" > /dev/null 2>&1 || true
      fi
    fi
  done
else
  echo "$LOG_PREFIX Self-test FAILED, rolling back..."
  rm -f wactl-bridge-new
  mv go.mod.bak go.mod
  mv go.sum.bak go.sum
  echo "$LOG_PREFIX Rolled back to $CURRENT"
  # Notify all instances with ntfy configured about the failure
  jq -r '.instances | to_entries[] | .key' "$INSTANCES_JSON" | while read -r INST; do
    INST_ENV="$INSTALL_DIR/instances/$INST/.env"
    if [ -f "$INST_ENV" ]; then
      NTFY=$(grep '^NTFY_TOPIC=' "$INST_ENV" 2>/dev/null | cut -d= -f2)
      NTFY_SRV=$(grep '^NTFY_SERVER=' "$INST_ENV" 2>/dev/null | cut -d= -f2-)
      NTFY_SRV="${NTFY_SRV:-https://ntfy.sh}"
      if [ -n "$NTFY" ]; then
        curl -s -d "Auto-update to $LATEST failed self-test. Rolled back to $CURRENT." \
          -H "Title: wactl — Auto-update Failed" -H "Priority: urgent" \
          "$NTFY_SRV/$NTFY" > /dev/null 2>&1 || true
      fi
    fi
  done
fi

echo "$LOG_PREFIX Done."
