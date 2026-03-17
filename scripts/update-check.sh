#!/bin/bash
# wactl auto-update check script
# Called by cron daily at 3 AM (configurable)
# Fetches latest whatsmeow, rebuilds bridge, self-tests, and swaps binary

set -e

INSTALL_DIR="${INSTALL_DIR:-/opt/wactl}"
BRIDGE_DIR="$INSTALL_DIR/bridge"
DATA_DIR="${DATA_DIR:-$INSTALL_DIR/data}"
LOG_PREFIX="[wactl-update $(date -Iseconds)]"
export PATH="$PATH:/usr/local/go/bin"

echo "$LOG_PREFIX Starting update check..."

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
  exit 1
fi

# Self-test: start on temp port and check /status
TEST_PORT=4099
echo "$LOG_PREFIX Self-testing on port $TEST_PORT..."
mkdir -p "$DATA_DIR/test"
DATA_DIR="$DATA_DIR/test" BRIDGE_PORT=$TEST_PORT ./wactl-bridge-new &
TEST_PID=$!
sleep 5

TEST_RESULT=$(curl -s "http://127.0.0.1:$TEST_PORT/status" 2>/dev/null || echo "FAIL")
kill $TEST_PID 2>/dev/null
wait $TEST_PID 2>/dev/null

if echo "$TEST_RESULT" | grep -q '"connected"'; then
  echo "$LOG_PREFIX Self-test PASSED"
  mv wactl-bridge-new wactl-bridge
  rm -f go.mod.bak go.sum.bak
  echo "$LOG_PREFIX Restarting bridge service..."
  systemctl restart wactl-bridge 2>/dev/null || true
  echo "$LOG_PREFIX Updated to $LATEST"
else
  echo "$LOG_PREFIX Self-test FAILED, rolling back..."
  rm -f wactl-bridge-new
  mv go.mod.bak go.mod
  mv go.sum.bak go.sum
  echo "$LOG_PREFIX Rolled back to $CURRENT"
fi

rm -rf "$DATA_DIR/test"
echo "$LOG_PREFIX Done."
