#!/bin/bash
set -e

echo "============================================"
echo "  wactl — One-Click Installer"
echo "============================================"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root: sudo bash install.sh"
  exit 1
fi

INSTALL_DIR="/opt/wactl"

# 1. Install system dependencies
echo "[1/10] Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq git curl build-essential sqlite3 > /dev/null

# 2. Install Go (if not present)
echo "[2/10] Checking Go..."
if ! command -v go &> /dev/null; then
  echo "  Installing Go 1.22..."
  wget -q https://go.dev/dl/go1.22.linux-amd64.tar.gz -O /tmp/go.tar.gz
  tar -C /usr/local -xzf /tmp/go.tar.gz
  rm /tmp/go.tar.gz
  export PATH=$PATH:/usr/local/go/bin
  echo 'export PATH=$PATH:/usr/local/go/bin' >> /etc/profile.d/go.sh
fi
echo "  Go: $(go version)"

# 3. Install Node.js 20 (if not present)
echo "[3/10] Checking Node.js..."
if ! command -v node &> /dev/null; then
  echo "  Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null
fi
echo "  Node: $(node --version)"

# 4. Clone and build
echo "[4/10] Cloning wactl..."
if [ -d "$INSTALL_DIR" ]; then
  echo "  Existing installation found, pulling latest..."
  cd "$INSTALL_DIR"
  git pull --ff-only
else
  git clone https://github.com/patildhruv/wactl.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# 5. Build Go bridge
echo "[5/10] Building Go bridge..."
cd "$INSTALL_DIR/bridge"
CGO_ENABLED=1 go build -o wactl-bridge .

# 6. Build TS server
echo "[6/10] Building TypeScript server..."
cd "$INSTALL_DIR/server"
npm ci --silent
npm run build

# 7. Generate credentials
echo "[7/10] Generating credentials..."
MCP_KEY=$(openssl rand -hex 32)
ADMIN_PASS=$(openssl rand -base64 12)
ADMIN_HASH=$(node -e "const b=require('bcryptjs');console.log(b.hashSync('$ADMIN_PASS',12))")

# 8. Write .env
echo "[8/10] Writing configuration..."
mkdir -p "$INSTALL_DIR/data"

cat > "$INSTALL_DIR/.env" << EOF
MCP_API_KEY=$MCP_KEY
ADMIN_USER=admin
ADMIN_PASSWORD_HASH=$ADMIN_HASH
ADMIN_PORT=8080
MCP_PORT=3000
BRIDGE_PORT=4000
CALLBACK_PORT=4001
DATA_DIR=$INSTALL_DIR/data
BRIDGE_DIR=$INSTALL_DIR/bridge
NOTIFY_METHOD=none
AUTO_UPDATE=true
AUTO_UPDATE_CRON=0 3 * * *
EOF

# 9. Create systemd services
echo "[9/10] Setting up systemd services..."

cat > /etc/systemd/system/wactl-bridge.service << EOF
[Unit]
Description=wactl WhatsApp Bridge
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR/bridge
ExecStart=$INSTALL_DIR/bridge/wactl-bridge
Restart=always
RestartSec=5
Environment=DATA_DIR=$INSTALL_DIR/data
Environment=BRIDGE_PORT=4000
Environment=CALLBACK_URL=http://127.0.0.1:4001/bridge/events

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/wactl-server.service << EOF
[Unit]
Description=wactl MCP + Admin Server
After=wactl-bridge.service
Requires=wactl-bridge.service

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR/server
ExecStart=/usr/bin/node $INSTALL_DIR/server/dist/index.js
Restart=always
RestartSec=5
EnvironmentFile=$INSTALL_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

# Setup auto-updater cron
echo "0 3 * * * root /opt/wactl/scripts/update-check.sh >> /var/log/wactl-update.log 2>&1" > /etc/cron.d/wactl-update

# 10. Start services
echo "[10/10] Starting services..."
systemctl daemon-reload
systemctl enable wactl-bridge wactl-server > /dev/null 2>&1
systemctl start wactl-bridge wactl-server

# Allow ports through firewall if ufw is active
if command -v ufw &> /dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 8080/tcp comment "wactl admin panel" > /dev/null 2>&1
  ufw allow 3000/tcp comment "wactl MCP server" > /dev/null 2>&1
fi

# Get server IP
SERVER_IP=$(hostname -I | awk '{print $1}')

echo ""
echo "============================================"
echo "  wactl installed successfully!"
echo "============================================"
echo ""
echo "  Admin Panel:  http://${SERVER_IP}:8080"
echo "  Admin User:   admin"
echo "  Admin Pass:   $ADMIN_PASS"
echo ""
echo "  MCP Endpoint: http://${SERVER_IP}:3000/mcp/sse"
echo "  MCP API Key:  $MCP_KEY"
echo ""
echo "  Save these credentials — the password"
echo "  cannot be recovered after this screen."
echo "============================================"
