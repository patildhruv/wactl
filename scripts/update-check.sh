#!/bin/bash
# wactl auto-update check script
# Called by cron, delegates to the TypeScript updater

set -e

INSTALL_DIR="${INSTALL_DIR:-/opt/wactl}"
LOG_PREFIX="[wactl-update $(date -Iseconds)]"

echo "$LOG_PREFIX Starting update check..."

# Check if the server is running and trigger an update check
curl -s http://127.0.0.1:8080/health > /dev/null 2>&1
if [ $? -ne 0 ]; then
  echo "$LOG_PREFIX Server not running, skipping update check"
  exit 0
fi

echo "$LOG_PREFIX Server is running, update check handled by built-in updater"
