#!/bin/bash
set -e

# wactl hotfix — fixes Caddy path stripping + MCP SSE endpoint
# Run on server: sudo bash /opt/wactl/scripts/hotfix-caddy-mcp.sh

INSTALL_DIR="/opt/wactl"
INSTANCES_JSON="$INSTALL_DIR/instances.json"
CADDYFILE="$INSTALL_DIR/Caddyfile"

if [ "$EUID" -ne 0 ]; then
  echo "Please run as root: sudo bash $0"
  exit 1
fi

if [ ! -f "$INSTANCES_JSON" ]; then
  echo "ERROR: No wactl installation found at $INSTALL_DIR"
  exit 1
fi

echo "============================================"
echo "  wactl hotfix — Caddy + MCP path fix"
echo "============================================"
echo ""

# 1. Pull latest code
echo "[1/5] Pulling latest code..."
cd "$INSTALL_DIR"
git pull --ff-only
echo ""

# 2. Rebuild TS server
echo "[2/5] Rebuilding TypeScript server..."
cd "$INSTALL_DIR/server"
npm ci --silent
npm run build
echo ""

# 3. Regenerate Caddyfile with fixed routing
echo "[3/5] Regenerating Caddyfile..."
echo "  Old Caddyfile:"
cat "$CADDYFILE" | sed 's/^/    /'
echo ""

hostname=$(jq -r '.hostname' "$INSTANCES_JSON")
{
  echo "${hostname} {"
  jq -r '.instances | to_entries | sort_by(.key)[] | "\(.key) \(.value.mcp_port) \(.value.admin_port)"' "$INSTANCES_JSON" | while read -r inst_name mcp_port admin_port; do
    echo "    handle /${inst_name}/mcp/* {"
    echo "        uri strip_prefix /${inst_name}"
    echo "        reverse_proxy localhost:${mcp_port}"
    echo "    }"
    echo "    handle /${inst_name}/* {"
    echo "        uri strip_prefix /${inst_name}"
    echo "        reverse_proxy localhost:${admin_port}"
    echo "    }"
  done
  echo "}"
} > "$CADDYFILE"

echo "  New Caddyfile:"
cat "$CADDYFILE" | sed 's/^/    /'
echo ""

# 4. Reload Caddy
echo "[4/5] Reloading Caddy..."
systemctl reload caddy

# 5. Restart all instance servers (bridge stays up — only TS server changed)
echo "[5/5] Restarting server services..."
jq -r '.instances | keys[]' "$INSTANCES_JSON" | while read -r inst_name; do
  echo "  Restarting wactl-${inst_name}-server..."
  systemctl restart "wactl-${inst_name}-server"
done
echo ""

# Verify
echo "Verifying services..."
jq -r '.instances | keys[]' "$INSTANCES_JSON" | while read -r inst_name; do
  BRIDGE=$(systemctl is-active "wactl-${inst_name}-bridge" 2>/dev/null || echo "failed")
  SERVER=$(systemctl is-active "wactl-${inst_name}-server" 2>/dev/null || echo "failed")
  echo "  ${inst_name}: bridge=${BRIDGE} server=${SERVER}"
done
echo ""

echo "============================================"
echo "  Hotfix applied!"
echo ""
echo "  Test MCP endpoint:"
echo "    curl -i https://${hostname}/$(jq -r '.instances | keys[0]' "$INSTANCES_JSON")/mcp/sse"
echo "============================================"
