#!/bin/sh
set -e

export DATA_DIR="${DATA_DIR:-/app/data}"
export BRIDGE_PORT="${BRIDGE_PORT:-4000}"
export CALLBACK_URL="http://127.0.0.1:${CALLBACK_PORT:-4001}/bridge/events"

echo "[wactl] Starting bridge on port ${BRIDGE_PORT}..."
./wactl-bridge &
BRIDGE_PID=$!

# Wait for bridge to be ready
sleep 2

echo "[wactl] Starting server..."
cd server
node dist/index.js &
SERVER_PID=$!

# Handle signals
trap "kill $BRIDGE_PID $SERVER_PID 2>/dev/null; exit 0" SIGTERM SIGINT

# Wait for either process to exit
wait -n $BRIDGE_PID $SERVER_PID 2>/dev/null || true
echo "[wactl] A process exited, shutting down..."
kill $BRIDGE_PID $SERVER_PID 2>/dev/null
wait
