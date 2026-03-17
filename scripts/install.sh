#!/bin/bash
set -e

# wactl — Multi-Instance Installer with HTTPS via Caddy
# Usage:
#   First install:  sudo bash install.sh --name dhruv --hostname wactl.example.com
#   Add instance:   sudo bash install.sh --name dad
#   Remove instance: sudo bash install.sh --remove --name dad

INSTALL_DIR="/opt/wactl"
INSTANCES_JSON="$INSTALL_DIR/instances.json"
CADDYFILE="$INSTALL_DIR/Caddyfile"

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------
NAME=""
HOSTNAME=""
REMOVE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --hostname) HOSTNAME="$2"; shift 2 ;;
    --remove) REMOVE=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Validation helpers
# ---------------------------------------------------------------------------
die() { echo "ERROR: $*" >&2; exit 1; }

validate_name() {
  [[ -n "$1" ]] || die "--name is required"
  [[ "$1" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$ ]] || die "Name must be alphanumeric (hyphens allowed, not at start/end): $1"
  [[ ${#1} -le 32 ]] || die "Name must be 32 characters or fewer"
}

validate_hostname() {
  [[ -n "$1" ]] || die "--hostname is required on first install"
  [[ "$1" != https://* ]] || die "--hostname should be a bare domain without https://"
  [[ "$1" != http://* ]] || die "--hostname should be a bare domain without http://"
  [[ "$1" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ ]] || die "Invalid hostname: $1"
}

# ---------------------------------------------------------------------------
# Check root
# ---------------------------------------------------------------------------
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root: sudo bash install.sh --name <name> --hostname <domain>"
  exit 1
fi

validate_name "$NAME"

# ---------------------------------------------------------------------------
# Detect first run vs subsequent run
# ---------------------------------------------------------------------------
FIRST_RUN=true
if [ -f "$INSTANCES_JSON" ]; then
  FIRST_RUN=false
fi

# ---------------------------------------------------------------------------
# Caddyfile generation function (defined early — used by --remove and install)
# ---------------------------------------------------------------------------
generate_caddyfile() {
  local hostname
  hostname=$(jq -r '.hostname' "$INSTANCES_JSON")
  {
    echo "${hostname} {"
    # Sort instances by name for deterministic output
    # MCP routes MUST come before admin routes (more specific first)
    jq -r '.instances | to_entries | sort_by(.key)[] | "\(.key) \(.value.mcp_port) \(.value.admin_port)"' "$INSTANCES_JSON" | while read -r inst_name mcp_port admin_port; do
      echo "    handle_path /${inst_name}/mcp/* {"
      echo "        reverse_proxy localhost:${mcp_port}"
      echo "    }"
      echo "    handle_path /${inst_name}/* {"
      echo "        reverse_proxy localhost:${admin_port}"
      echo "    }"
    done
    echo "}"
  } > "$CADDYFILE"
}

# ---------------------------------------------------------------------------
# Remove instance
# ---------------------------------------------------------------------------
if [ "$REMOVE" = true ]; then
  [ "$FIRST_RUN" = false ] || die "No wactl installation found — nothing to remove"

  # Check instance exists
  EXISTING=$(jq -r --arg n "$NAME" '.instances[$n] // empty' "$INSTANCES_JSON")
  [ -n "$EXISTING" ] || die "Instance '$NAME' does not exist"

  echo "============================================"
  echo "  Removing wactl instance: $NAME"
  echo "============================================"
  echo ""

  # Stop and disable services
  echo "[1/4] Stopping services..."
  systemctl stop "wactl-${NAME}-bridge" "wactl-${NAME}-server" 2>/dev/null || true
  systemctl disable "wactl-${NAME}-bridge" "wactl-${NAME}-server" 2>/dev/null || true
  rm -f "/etc/systemd/system/wactl-${NAME}-bridge.service"
  rm -f "/etc/systemd/system/wactl-${NAME}-server.service"
  systemctl daemon-reload

  # Remove from instances.json
  echo "[2/4] Updating instance registry..."
  jq --arg n "$NAME" 'del(.instances[$n])' "$INSTANCES_JSON" > "${INSTANCES_JSON}.tmp"
  mv "${INSTANCES_JSON}.tmp" "$INSTANCES_JSON"

  # Regenerate Caddyfile
  echo "[3/4] Updating Caddy configuration..."
  generate_caddyfile
  systemctl reload caddy 2>/dev/null || true

  # Report on data directory
  INSTANCE_DIR="$INSTALL_DIR/instances/$NAME"
  echo "[4/4] Cleaning up..."
  echo ""
  echo "============================================"
  echo "  Instance '$NAME' removed."
  echo "============================================"
  echo ""
  if [ -d "$INSTANCE_DIR" ]; then
    echo "  Instance data preserved at:"
    echo "    $INSTANCE_DIR"
    echo ""
    echo "  To delete permanently:"
    echo "    rm -rf $INSTANCE_DIR"
  fi
  echo "============================================"
  exit 0
fi

# ---------------------------------------------------------------------------
# First-run validations
# ---------------------------------------------------------------------------
if [ "$FIRST_RUN" = true ]; then
  validate_hostname "$HOSTNAME"
else
  # Subsequent run — hostname comes from instances.json
  STORED_HOSTNAME=$(jq -r '.hostname' "$INSTANCES_JSON")
  if [ -n "$HOSTNAME" ] && [ "$HOSTNAME" != "$STORED_HOSTNAME" ]; then
    echo "WARNING: Hostname already set to '$STORED_HOSTNAME' — ignoring --hostname '$HOSTNAME'"
  fi
  HOSTNAME="$STORED_HOSTNAME"

  # Check instance doesn't already exist
  EXISTING=$(jq -r --arg n "$NAME" '.instances[$n] // empty' "$INSTANCES_JSON")
  [ -z "$EXISTING" ] || die "Instance '$NAME' already exists"
fi

echo "============================================"
echo "  wactl — Multi-Instance Installer"
echo "============================================"
echo ""

if [ "$FIRST_RUN" = true ]; then
  echo "  Mode:     First install"
else
  echo "  Mode:     Adding instance"
fi
echo "  Instance: $NAME"
echo "  Hostname: $HOSTNAME"
echo ""

# ---------------------------------------------------------------------------
# FIRST RUN: Install system dependencies + build tools
# ---------------------------------------------------------------------------
if [ "$FIRST_RUN" = true ]; then
  TOTAL_STEPS=12

  # 1. System dependencies
  echo "[1/${TOTAL_STEPS}] Installing system dependencies..."
  apt-get update -qq
  apt-get install -y -qq git curl build-essential sqlite3 jq debian-keyring debian-archive-keyring apt-transport-https > /dev/null

  # 2. Install Go
  echo "[2/${TOTAL_STEPS}] Checking Go..."
  if ! command -v go &> /dev/null || [[ "$(go version)" != *"go1.25"* && "$(go version)" != *"go1.26"* ]]; then
    echo "  Installing Go 1.25..."
    wget -q https://go.dev/dl/go1.25.8.linux-amd64.tar.gz -O /tmp/go.tar.gz
    rm -rf /usr/local/go
    tar -C /usr/local -xzf /tmp/go.tar.gz
    rm /tmp/go.tar.gz
    export PATH=$PATH:/usr/local/go/bin
    echo 'export PATH=$PATH:/usr/local/go/bin' >> /etc/profile.d/go.sh
  fi
  echo "  Go: $(go version)"

  # 3. Install Node.js 20
  echo "[3/${TOTAL_STEPS}] Checking Node.js..."
  if ! command -v node &> /dev/null; then
    echo "  Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
    apt-get install -y -qq nodejs > /dev/null
  fi
  echo "  Node: $(node --version)"

  # 4. Install Caddy
  echo "[4/${TOTAL_STEPS}] Installing Caddy..."
  if ! command -v caddy &> /dev/null; then
    # Check if ports 80/443 are already in use
    if ss -tlnp | grep -qE ':80\s'; then
      echo "WARNING: Port 80 is already in use. Caddy needs ports 80 and 443 for automatic HTTPS."
      echo "  You may need to stop the existing service (e.g., nginx, apache2) before continuing."
    fi
    if ss -tlnp | grep -qE ':443\s'; then
      echo "WARNING: Port 443 is already in use."
    fi
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
    apt-get update -qq
    apt-get install -y -qq caddy > /dev/null
  fi
  echo "  Caddy: $(caddy version)"

  # 5. Clone repo
  echo "[5/${TOTAL_STEPS}] Cloning wactl..."
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "  Existing repo found, pulling latest..."
    cd "$INSTALL_DIR"
    git pull --ff-only
  else
    mkdir -p "$INSTALL_DIR"
    git clone https://github.com/patildhruv/wactl.git "${INSTALL_DIR}.tmp"
    # Move contents into INSTALL_DIR (which may already exist as empty dir)
    cp -a "${INSTALL_DIR}.tmp/." "$INSTALL_DIR/"
    rm -rf "${INSTALL_DIR}.tmp"
    cd "$INSTALL_DIR"
  fi

  # 6. Build Go bridge
  echo "[6/${TOTAL_STEPS}] Building Go bridge..."
  cd "$INSTALL_DIR/bridge"
  echo "  Fetching latest whatsmeow..."
  GOFLAGS="-mod=mod" go get go.mau.fi/whatsmeow@latest 2>&1 | tail -1
  go mod tidy
  CGO_ENABLED=1 go build -o wactl-bridge .

  # 7. Build TS server
  echo "[7/${TOTAL_STEPS}] Building TypeScript server..."
  cd "$INSTALL_DIR/server"
  npm ci --silent
  npm run build

  # 8. Create instance directory structure
  echo "[8/${TOTAL_STEPS}] Creating instance '$NAME'..."
  INSTANCE_INDEX=0
  mkdir -p "$INSTALL_DIR/instances"
  # (instance creation continues below in shared section)

else
  # -----------------------------------------------------------------
  # SUBSEQUENT RUN: Skip deps/build, just create the new instance
  # -----------------------------------------------------------------
  TOTAL_STEPS=5
  echo "[1/${TOTAL_STEPS}] Existing installation detected, skipping build..."

  # Determine next instance index
  INSTANCE_INDEX=$(jq '[.instances[].index] | max + 1' "$INSTANCES_JSON")
  echo "  Instance index: $INSTANCE_INDEX"
fi

# ---------------------------------------------------------------------------
# Shared: Create the instance (both first run and subsequent)
# ---------------------------------------------------------------------------
if [ "$FIRST_RUN" = true ]; then
  STEP_CRED=8
  STEP_SVC=9
  STEP_REGISTRY=10
  STEP_CADDY=11
  STEP_START=12
else
  STEP_CRED=2
  STEP_SVC=3
  STEP_REGISTRY=4
  STEP_CADDY=4  # combined with registry step
  STEP_START=5
fi

# Calculate ports
ADMIN_PORT=$((8080 + INSTANCE_INDEX))
MCP_PORT=$((3000 + INSTANCE_INDEX))
BRIDGE_PORT=$((4000 + INSTANCE_INDEX * 10))
CALLBACK_PORT=$((4000 + INSTANCE_INDEX * 10 + 1))

INSTANCE_DIR="$INSTALL_DIR/instances/$NAME"
mkdir -p "$INSTANCE_DIR/data"

# Copy bridge binary (copy, not symlink — allows hot-swap on update)
cp "$INSTALL_DIR/bridge/wactl-bridge" "$INSTANCE_DIR/wactl-bridge"

# Generate credentials
echo "[${STEP_CRED}/${TOTAL_STEPS}] Generating credentials for '$NAME'..."
MCP_KEY=$(openssl rand -hex 32)
ADMIN_PASS=$(openssl rand -base64 12)
ADMIN_HASH=$(cd "$INSTALL_DIR/server" && node -e "const b=require('bcryptjs');console.log(b.hashSync('$ADMIN_PASS',12))")

# Write instance .env
cat > "$INSTANCE_DIR/.env" << EOF
MCP_API_KEY=$MCP_KEY
ADMIN_USER=admin
ADMIN_PASSWORD_HASH=$ADMIN_HASH
ADMIN_PORT=$ADMIN_PORT
MCP_PORT=$MCP_PORT
BRIDGE_PORT=$BRIDGE_PORT
CALLBACK_PORT=$CALLBACK_PORT
DATA_DIR=$INSTANCE_DIR/data
BRIDGE_DIR=$INSTALL_DIR/bridge
NOTIFY_METHOD=none
AUTO_UPDATE=true
EOF

# Create systemd services
echo "[${STEP_SVC}/${TOTAL_STEPS}] Creating systemd services..."

cat > "/etc/systemd/system/wactl-${NAME}-bridge.service" << EOF
[Unit]
Description=wactl WhatsApp Bridge ($NAME)
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTANCE_DIR
ExecStart=$INSTANCE_DIR/wactl-bridge
Restart=always
RestartSec=5
Environment=DATA_DIR=$INSTANCE_DIR/data
Environment=BRIDGE_PORT=$BRIDGE_PORT
Environment=CALLBACK_URL=http://127.0.0.1:${CALLBACK_PORT}/bridge/events

[Install]
WantedBy=multi-user.target
EOF

cat > "/etc/systemd/system/wactl-${NAME}-server.service" << EOF
[Unit]
Description=wactl MCP + Admin Server ($NAME)
After=wactl-${NAME}-bridge.service
Requires=wactl-${NAME}-bridge.service

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR/server
ExecStart=/usr/bin/node $INSTALL_DIR/server/dist/index.js
Restart=always
RestartSec=5
EnvironmentFile=$INSTANCE_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

# Update instance registry and Caddyfile
if [ "$FIRST_RUN" = true ]; then
  echo "[${STEP_REGISTRY}/${TOTAL_STEPS}] Initializing instance registry..."
else
  echo "[${STEP_REGISTRY}/${TOTAL_STEPS}] Updating instance registry and Caddy..."
fi

# Build or update instances.json
if [ "$FIRST_RUN" = true ]; then
  cat > "$INSTANCES_JSON" << EOF
{
  "hostname": "$HOSTNAME",
  "instances": {
    "$NAME": {
      "admin_port": $ADMIN_PORT,
      "mcp_port": $MCP_PORT,
      "bridge_port": $BRIDGE_PORT,
      "callback_port": $CALLBACK_PORT,
      "index": $INSTANCE_INDEX
    }
  }
}
EOF
else
  jq --arg n "$NAME" \
     --argjson ap "$ADMIN_PORT" \
     --argjson mp "$MCP_PORT" \
     --argjson bp "$BRIDGE_PORT" \
     --argjson cp "$CALLBACK_PORT" \
     --argjson idx "$INSTANCE_INDEX" \
     '.instances[$n] = {"admin_port": $ap, "mcp_port": $mp, "bridge_port": $bp, "callback_port": $cp, "index": $idx}' \
     "$INSTANCES_JSON" > "${INSTANCES_JSON}.tmp"
  mv "${INSTANCES_JSON}.tmp" "$INSTANCES_JSON"
fi

# Generate Caddyfile and reload
if [ "$FIRST_RUN" = true ]; then
  echo "[${STEP_CADDY}/${TOTAL_STEPS}] Configuring Caddy reverse proxy..."
fi
generate_caddyfile

# Point Caddy at our Caddyfile
if [ "$FIRST_RUN" = true ]; then
  # Override default Caddy config to use our Caddyfile
  mkdir -p /etc/caddy
  ln -sf "$CADDYFILE" /etc/caddy/Caddyfile
fi
systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true

# Setup auto-updater cron (first run only — shared across all instances)
if [ "$FIRST_RUN" = true ]; then
  echo "0 3 * * * root /opt/wactl/scripts/update-check.sh >> /var/log/wactl-update.log 2>&1" > /etc/cron.d/wactl-update
fi

# Firewall: open 80/443 for Caddy, close direct instance ports
if [ "$FIRST_RUN" = true ]; then
  if command -v ufw &> /dev/null && ufw status | grep -q "Status: active"; then
    ufw allow 80/tcp comment "wactl Caddy HTTP" > /dev/null 2>&1
    ufw allow 443/tcp comment "wactl Caddy HTTPS" > /dev/null 2>&1
    # Deny direct access to instance ports (optional — they only bind localhost by default)
    ufw deny 8080:8099/tcp comment "wactl admin direct (use Caddy)" > /dev/null 2>&1 || true
    ufw deny 3000:3099/tcp comment "wactl MCP direct (use Caddy)" > /dev/null 2>&1 || true
  fi
fi

# Start services
echo "[${STEP_START}/${TOTAL_STEPS}] Starting services..."
systemctl daemon-reload
systemctl enable "wactl-${NAME}-bridge" "wactl-${NAME}-server" > /dev/null 2>&1
systemctl start "wactl-${NAME}-bridge" "wactl-${NAME}-server"

# ---------------------------------------------------------------------------
# Output credentials
# ---------------------------------------------------------------------------
echo ""
echo "============================================"
echo "  wactl instance \"$NAME\" installed!"
echo "============================================"
echo ""
echo "  Admin Panel:  https://${HOSTNAME}/${NAME}/"
echo "  Admin User:   admin"
echo "  Admin Pass:   $ADMIN_PASS"
echo ""
echo "  MCP Endpoint: https://${HOSTNAME}/${NAME}/mcp/sse"
echo "  MCP API Key:  $MCP_KEY"
echo ""
echo "  Add to your MCP client config:"
echo "  {"
echo "    \"mcpServers\": {"
echo "      \"whatsapp-${NAME}\": {"
echo "        \"url\": \"https://${HOSTNAME}/${NAME}/mcp/sse\","
echo "        \"headers\": { \"X-API-Key\": \"${MCP_KEY}\" }"
echo "      }"
echo "    }"
echo "  }"
echo ""
echo "  Save these credentials — the password"
echo "  cannot be recovered after this screen."
echo "============================================"
