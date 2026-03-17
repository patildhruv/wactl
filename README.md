# wactl

> A production-ready, self-hosted WhatsApp MCP server with a web-based admin panel, API key authentication, auto-updater, and one-click deployment.

Originally forked from [lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp).

---

## What This Is

wactl is a WhatsApp bridge that connects your personal WhatsApp account to any MCP-compatible LLM client (Claude Desktop, Cursor, VS Code Copilot, etc.). Unlike other projects, wactl is designed for **unattended server deployment** — no SSH needed to re-authenticate, no manual restarts, no babysitting.

## Why This Exists

Every WhatsApp MCP server out there has the same problems:

- WhatsApp updates break the session → you SSH in, regenerate QR, restart
- No auth on the MCP endpoint → anyone on the network can read your chats
- No update mechanism → you find out it's broken only when it stops working

wactl fixes all of that.

## Features

- **WhatsApp ↔ LLM Bridge** — Read messages, search contacts, send messages, download media — all via MCP tools
- **Web Admin Panel** — Browser-based QR authentication with bcrypt password protection. No SSH required to re-login
- **API Key Authentication** — Secure your MCP endpoint with an API key. Only authorized LLM clients can connect
- **Auto-Updater** — Daily check for whatsmeow updates. Auto-pulls, rebuilds, self-tests, and restarts. Alerts you if manual intervention is needed
- **Push Notifications** — ntfy.sh integration alerts you when QR re-scan is needed
- **CLI Management** — `wactl status`, `wactl logs`, `wactl restart` — manage from terminal
- **Docker Support** — Multi-stage Dockerfile + docker-compose for multi-account deployment
- **One-Click Install** — Single bash script sets up everything on Ubuntu/Debian

## Architecture

```
┌──────────────────────────────────────────────────┐
│  PROCESS 1: Go Binary (wactl-bridge)             │
│  - whatsmeow client (WhatsApp multi-device API)  │
│  - SQLite session + message store                │
│  - HTTP API on localhost:4000 (internal only)    │
└────────────────────┬─────────────────────────────┘
                     │ http://localhost:4000
┌────────────────────▼─────────────────────────────┐
│  PROCESS 2: TypeScript Server (wactl-server)     │
│  - MCP server (JSON-RPC over SSE, port 3000)     │
│  - Web admin panel (port 8080)                   │
│  - ntfy.sh push notifications                    │
│  - Auto-updater (daily cron)                     │
│  - CLI wrapper (wactl command)                   │
└──────────────────────────────────────────────────┘
```

## Quick Start

### One-Click Install (Ubuntu/Debian)

```bash
curl -fsSL https://raw.githubusercontent.com/patildhruv/wactl/main/scripts/install.sh | sudo bash
```

Or clone and run manually:

```bash
git clone https://github.com/patildhruv/wactl.git
cd wactl
sudo bash scripts/install.sh
```

The install script will:

1. Install system dependencies (Go, Node.js, SQLite)
2. Build the Go bridge and TypeScript server
3. Generate random MCP API key and admin password
4. Create systemd services
5. Configure firewall rules
6. Start services and print your credentials

### Docker

```bash
# Build
cd docker
docker compose build

# Configure
cp ../.env.example ../envs/primary.env
# Edit envs/primary.env with your credentials

# Run
docker compose up -d
```

### First-Time Authentication

1. Open `http://<your-server-ip>:8080` in your browser
2. Log in with the admin credentials
3. Go to **QR Auth** page
4. Scan the QR code with WhatsApp (Linked Devices → Link a Device)
5. Done. The session persists across restarts

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

Copy `.env.example` to `.env` and edit:

| Variable | Description | Default |
|----------|-------------|---------|
| `MCP_API_KEY` | API key for MCP endpoint authentication | Auto-generated |
| `ADMIN_PASSWORD_HASH` | bcrypt hash of admin password | Auto-generated |
| `ADMIN_USER` | Admin panel username | `admin` |
| `ADMIN_PORT` | Web admin panel port | `8080` |
| `MCP_PORT` | MCP SSE server port | `3000` |
| `BRIDGE_PORT` | Internal Go bridge port (localhost only) | `4000` |
| `NOTIFY_METHOD` | `ntfy` or `none` | `none` |
| `NTFY_TOPIC` | ntfy.sh topic name | — |
| `AUTO_UPDATE` | Enable daily auto-update checks | `true` |
| `AUTO_UPDATE_CRON` | Cron schedule for update checks | `0 3 * * *` |
| `DATA_DIR` | Path to SQLite + session data | `./data` |

## CLI Usage

```bash
wactl status     # Show connection health, uptime, MCP status
wactl logs       # Tail live logs (systemd)
wactl restart    # Restart bridge and server
wactl update     # Trigger manual update check
wactl auth       # Show QR status + admin panel URL
wactl config     # Print current config (secrets redacted)
```

## MCP Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_chats` | List all conversations | `limit?: number` |
| `get_chat` | Get message history | `chatId: string, limit?: number` |
| `search_contacts` | Search contacts | `query: string` |
| `send_message` | Send text message | `to: string, body: string` |
| `send_file` | Send file/image | `to: string, filePath: string, caption?: string` |
| `download_media` | Download media | `messageId: string` |
| `get_connection_status` | Check bridge status | — |

## Project Structure

```
wactl/
├── bridge/               # Go binary — WhatsApp bridge
│   ├── main.go           # Entry point, connection setup
│   ├── handlers.go       # Event handlers (QR, messages, history sync)
│   ├── api.go            # HTTP API routes
│   └── store.go          # SQLite operations
├── server/               # TypeScript — everything else
│   ├── src/
│   │   ├── index.ts      # Entry point (starts MCP + admin servers)
│   │   ├── mcp/          # MCP JSON-RPC server + tools + auth
│   │   ├── admin/        # Admin panel routes + views
│   │   ├── bridge/       # HTTP client for Go bridge API
│   │   ├── notify/       # ntfy.sh push notifications
│   │   ├── updater/      # Auto-update logic
│   │   └── cli/          # CLI wrapper (wactl command)
├── docker/               # Dockerfile + docker-compose
├── scripts/              # Install script + update-check
├── .env.example
├── CONTRIBUTING.md
└── LICENSE
```

## Security

- **Admin panel** — Password is bcrypt hashed. Sessions expire after 24h. Rate-limited login (5 attempts/min)
- **MCP endpoint** — Requires `X-API-Key` header on every request
- **Bridge API** — Listens only on localhost:4000, not externally accessible
- **WhatsApp data** — All messages stored locally in SQLite. Nothing leaves your server

## License

MIT — see [LICENSE](LICENSE).
