# wactl

> A production-ready, self-hosted WhatsApp MCP server with a web-based admin panel, API key authentication, auto-updater, and one-click deployment.

Originally forked from [lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp).

---

## What This Is

wactl is a WhatsApp bridge that connects your personal WhatsApp account to any MCP-compatible LLM client (Claude, Cursor, VS Code Copilot, etc.). Unlike the original project, wactl is designed for **unattended server deployment** — no SSH needed to re-authenticate, no manual restarts, no babysitting.

## Why This Exists

Every WhatsApp MCP server out there has the same problems:

- WhatsApp updates break the session → you SSH in, regenerate QR, restart
- No auth on the MCP endpoint → anyone on the network can read your chats
- No update mechanism → you find out it's broken only when it stops working

wactl fixes all of that.

## Features

- **WhatsApp ↔ LLM Bridge** — Read messages, search contacts, send messages, download media — all via MCP tools
- **Web Admin Panel** — Browser-based QR authentication with salted password protection. No SSH required to re-login
- **API Key Authentication** — Secure your MCP endpoint with an API key. Only authorized LLM clients can connect
- **Auto-Updater** — Daily check for whatsmeow upstream updates. Auto-pulls, rebuilds, tests, and restarts. Alerts you if manual intervention is needed
- **Self-Healing** — Auto-reconnects on transient failures. Pushes notifications (ntfy/Telegram) when QR re-scan is needed
- **One-Click Install** — Single bash script sets up everything: dependencies, build, systemd service, firewall rules

## Architecture

```
┌──────────────┐     API Key Auth     ┌──────────────────┐
│  LLM Client  │ ◄──────────────────► │   wactl MCP      │
│  (Claude /   │     (SSE / stdio)    │   (JSON-RPC)     │
│   Cursor)    │                      └────────┬─────────┘
└──────────────┘                               │
                                               ▼
                                      ┌────────────────┐
                                      │  WhatsApp Core │
                                      │  (whatsmeow)   │
                                      │  SQLite store  │
                                      └───────┬────────┘
                                              │
                           ┌──────────────────┼──────────────────┐
                           ▼                  ▼                  ▼
                  ┌─────────────────┐ ┌──────────────┐ ┌─────────────────┐
                  │  Admin Web UI   │ │   Health      │ │  Auto-Updater   │
                  │  (QR + Status)  │ │   Monitor     │ │  (Daily Cron)   │
                  └─────────────────┘ └──────────────┘ └─────────────────┘
```

## Quick Start

### One-Click Install

```bash
curl -fsSL https://raw.githubusercontent.com/patildhruv/wactl/main/install.sh | bash
```

Or clone and run manually:

```bash
git clone https://github.com/patildhruv/wactl.git
cd wactl
chmod +x install.sh
./install.sh
```

The install script will:

1. Install system dependencies (Go, Node.js, SQLite)
2. Build the whatsmeow bridge and MCP server
3. Generate a random MCP API key and admin password
4. Create a systemd service (`wactl.service`)
5. Configure UFW firewall rules
6. Start the service and print your credentials

### First-Time Authentication

1. Open `http://<your-server-ip>:8080` in your browser
2. Log in with the admin password printed during install
3. Scan the QR code with your WhatsApp (Linked Devices → Link a Device)
4. Done. The session persists across restarts

### Connect Your LLM Client

Add to your MCP client config (e.g., `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "whatsapp": {
      "url": "http://<your-server-ip>:3000/mcp/sse",
      "headers": {
        "X-API-Key": "<your-api-key>"
      }
    }
  }
}
```

## Configuration

Copy the example env file and edit:

```bash
cp .env.example .env
```

| Variable           | Description                                        | Default        |
| ------------------ | -------------------------------------------------- | -------------- |
| `MCP_API_KEY`      | API key for MCP endpoint authentication            | Auto-generated |
| `ADMIN_PASSWORD`   | Password for the web admin panel (stored salted)   | Auto-generated |
| `ADMIN_PORT`       | Port for the web admin panel                       | `8080`         |
| `MCP_PORT`         | Port for the MCP SSE server                        | `3000`         |
| `NOTIFY_METHOD`    | Notification method: `ntfy`, `telegram`, or `none` | `none`         |
| `NOTIFY_URL`       | ntfy topic URL or Telegram bot token               | —              |
| `AUTO_UPDATE`      | Enable daily auto-update checks                    | `true`         |
| `AUTO_UPDATE_CRON` | Cron schedule for update checks                    | `0 3 * * *`    |

## CLI Usage

```bash
wactl status          # Check connection health
wactl restart         # Restart the service
wactl logs            # Tail live logs
wactl update          # Manually trigger an update check
wactl auth            # Print admin panel URL + QR status
```

## MCP Tools

| Tool                    | Description                                |
| ----------------------- | ------------------------------------------ |
| `list_chats`            | List all chats with last message preview   |
| `get_chat`              | Get full chat history with a contact/group |
| `search_contacts`       | Search contacts by name or number          |
| `send_message`          | Send a text message to a contact or group  |
| `send_file`             | Send a file/image/document                 |
| `download_media`        | Download media from a message              |
| `get_connection_status` | Check WhatsApp connection health           |

## Auto-Updater

A daily cron job checks for new whatsmeow releases. When an update is found:

1. Pulls the latest whatsmeow dependency
2. Rebuilds the bridge binary
3. Runs a self-test (sends a test message to your own number)
4. If the test passes → restarts the service automatically
5. If the test fails → keeps the old binary running and sends you a notification

Disable with `AUTO_UPDATE=false` in `.env`.

## Security

- **Admin panel** — Password is salted and hashed (bcrypt). Sessions expire after 24h
- **MCP endpoint** — Requires `X-API-Key` header on every request
- **WhatsApp data** — All messages stored locally in SQLite. Nothing leaves your server unless you query it through MCP
- **Firewall** — Install script configures UFW to only expose admin and MCP ports

## Deployment

### Docker

```bash
docker build -t wactl .
docker run -d \
  --name wactl \
  -p 8080:8080 \
  -p 3000:3000 \
  -v wactl-data:/app/data \
  --env-file .env \
  wactl
```

### systemd (Bare Metal)

The install script creates this automatically. To manage manually:

```bash
sudo systemctl start wactl
sudo systemctl stop wactl
sudo systemctl status wactl
journalctl -u wactl -f  # live logs
```

## Roadmap

- [ ] Web admin panel with QR authentication
- [ ] API key authentication for MCP endpoint
- [ ] Auto-updater with self-test
- [ ] One-click install script
- [ ] CLI wrapper (`wactl` commands)
- [ ] Docker support
- [ ] Push notifications (ntfy, Telegram) on session loss
- [ ] Group management tools
- [ ] Message scheduling
- [ ] Incoming message webhooks for real-time LLM triggers

## Contributing

Contributions welcome.

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/your-feature`)
3. Commit with clear messages
4. Open a PR against `main`
