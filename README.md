<p align="center">
  <h1 align="center">wactl</h1>
  <p align="center">
    <strong>Your WhatsApp, wired directly into your LLM.</strong>
    <br />
    Self-hosted · MCP-native · Zero babysitting
    <br /><br />
    <a href="#quick-start">Quick Start</a> · <a href="#features">Features</a> · <a href="MAINTENANCE.md">Maintenance Guide</a> · <a href="#architecture">Architecture</a>
  </p>
</p>

<br />

> **wactl** is a production-grade WhatsApp bridge that connects your personal WhatsApp account to any MCP-compatible LLM client — Claude Desktop, Cursor, VS Code Copilot, you name it. Deploy it on a server and forget about it. It updates itself, heals itself, and yells at you (via push notification) only when it genuinely needs you.

Originally forked from [lharries/whatsapp-mcp](https://github.com/lharries/whatsapp-mcp). Rewritten from scratch.

---

## The Problem

Every WhatsApp MCP server has the same three failure modes:

1. **WhatsApp pushes an update** → your bridge silently dies → you find out 3 days later
2. **No auth on the MCP endpoint** → anyone on your network can read your chats
3. **QR code expires** → SSH in, restart, scan QR from terminal, pray

wactl solves all three. Auto-updates, API key auth, and a web-based admin panel for QR re-authentication — no SSH required.

---

## Features

| | |
|---|---|
| 🔌 **WhatsApp ↔ LLM Bridge** | Read messages, search contacts, send messages, download media — all via MCP tools |
| 🖥️ **Web Admin Panel** | Browser-based QR login with bcrypt auth. Re-authenticate from your phone, not your terminal |
| 🔐 **API Key Auth** | Every MCP request requires `X-API-Key`. No key, no access |
| 🔄 **Self-Healing Updates** | Daily cron fetches latest whatsmeow, builds, self-tests, and hot-swaps the binary. Rolls back on failure |
| 📲 **Push Notifications** | Self-hosted or [ntfy.sh](https://ntfy.sh) alerts for disconnects, QR ready, reconnects, and update status |
| 🛠️ **CLI** | `wactl status`, `wactl logs`, `wactl restart` — everything from terminal |
| 🐳 **Docker** | Multi-stage build + docker-compose for multi-account setups |
| ⚡ **One-Command Install** | Single `curl` command sets up everything on Ubuntu/Debian |

---

## Quick Start

### One-Command Install

```bash
curl -fsSL https://raw.githubusercontent.com/patildhruv/wactl/main/scripts/install.sh -o install.sh
sudo bash install.sh --name myinstance --hostname wactl.example.com
```

The script installs Go 1.25+, Node.js 20, Caddy, fetches the latest whatsmeow, builds everything, generates credentials, creates systemd services, and starts it all up. Your credentials are printed once — save them.

With push notifications (topic defaults to instance name):
```bash
sudo bash install.sh --name myname --hostname wactl.example.com --ntfy
```

Add more instances later:
```bash
sudo bash /opt/wactl/scripts/install.sh --name another --ntfy
```

### Or Clone Manually

```bash
git clone https://github.com/patildhruv/wactl.git
cd wactl
sudo bash scripts/install.sh --name myinstance --hostname wactl.example.com
```

### Docker

```bash
cd docker
cp ../.env.example ../envs/primary.env
# Edit envs/primary.env with your settings
docker compose up -d
```

---

## First-Time Setup

1. Open `https://<your-hostname>/<instance-name>/` in your browser
2. Log in with the admin credentials (printed during install)
3. Navigate to **QR Auth**
4. Open WhatsApp on your phone → **Linked Devices** → **Link a Device**
5. Scan the QR code
6. Done. Session persists across restarts

---

## Connect Your LLM Client

Add to your MCP client config (e.g., Claude Desktop):

```json
{
  "mcpServers": {
    "whatsapp": {
      "url": "https://<your-hostname>/<instance-name>/mcp/sse",
      "headers": {
        "X-API-Key": "<your-api-key>"
      }
    }
  }
}
```

Now ask Claude: *"Summarize my unread WhatsApp messages"* — and it just works.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│            PROCESS 1: Go Bridge (port 4000)          │
│                                                     │
│   whatsmeow ←→ WhatsApp Web multi-device protocol  │
│   SQLite store (sessions + messages)                │
│   REST API (localhost only — not exposed)           │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP (internal)
┌──────────────────────▼──────────────────────────────┐
│            PROCESS 2: TS Server                      │
│                                                     │
│   MCP Server ─── JSON-RPC over SSE (port 3000)     │
│   Admin Panel ── Web UI + QR auth (port 8080)      │
│   Callbacks ──── Bridge event handler (port 4001)  │
│   Updater ────── Daily whatsmeow auto-update       │
│   CLI ────────── wactl command wrapper             │
│   Notify ─────── Push notifications (self-hosted/ntfy.sh) │
└─────────────────────────────────────────────────────┘
```

---

## Configuration

Copy `.env.example` to `.env` and configure:

| Variable | Description | Default |
|---|---|---|
| `MCP_API_KEY` | API key for MCP endpoint | Auto-generated |
| `ADMIN_PASSWORD_HASH` | bcrypt hash of admin password | Auto-generated |
| `ADMIN_USER` | Admin panel username | `admin` |
| `ADMIN_PORT` | Web admin panel port | `8080` |
| `MCP_PORT` | MCP SSE server port | `3000` |
| `BRIDGE_PORT` | Internal Go bridge port | `4000` |
| `NOTIFY_METHOD` | `ntfy` or `none` | `none` |
| `NTFY_TOPIC` | ntfy topic name | instance name |
| `NTFY_SERVER` | ntfy server URL | `http://localhost:2586` (if local ntfy detected) or `https://ntfy.sh` |
| `AUTO_UPDATE` | Enable daily update checks | `true` |
| `AUTO_UPDATE_CRON` | Cron schedule for updates | `0 3 * * *` |
| `DATA_DIR` | Path to SQLite + session data | `./data` |

---

## Push Notifications

wactl sends push notifications for disconnects, QR ready, reconnects, auto-update success, and auto-update failures. You can use the public [ntfy.sh](https://ntfy.sh) service or self-host ntfy on the same server.

### Self-hosted ntfy (recommended)

Keeps notifications private — no public topics.

```bash
# Install ntfy
sudo apt install ntfy

# Configure /etc/ntfy/server.yml:
#   base-url: "https://your-hostname.com"
#   listen-http: ":2586"
#   behind-proxy: true
#   cache-file: "/var/cache/ntfy/cache.db"

sudo systemctl enable --now ntfy
```

The installer auto-detects a local ntfy service and configures everything:
```bash
sudo bash install.sh --name myname --hostname wactl.example.com --ntfy
# → NTFY_SERVER=http://localhost:2586, NTFY_TOPIC=myname
```

Caddy automatically gets a `/ntfy/*` reverse proxy route, so mobile apps connect via HTTPS.

**Android/iOS app setup:** Add server `https://<your-hostname>/ntfy` → subscribe to topic `<instance-name>`.

### Public ntfy.sh

```bash
sudo bash install.sh --name myname --hostname wactl.example.com --ntfy --ntfy-server https://ntfy.sh
```

Use a hard-to-guess topic name since ntfy.sh topics are public.

### Install flags

| Flag | Description |
|---|---|
| `--ntfy` | Enable notifications, topic defaults to instance name |
| `--ntfy <topic>` | Enable with a custom topic name |
| `--ntfy-server <url>` | Override ntfy server URL |

---

## CLI

```bash
wactl status     # Connection health, uptime, MCP status
wactl logs       # Tail live logs
wactl restart    # Restart bridge + server
wactl update     # Trigger manual update check
wactl auth       # QR status + admin panel URL
wactl config     # Print current config (secrets redacted)
```

---

## MCP Tools

These are the tools your LLM client gets access to:

| Tool | What It Does | Parameters |
|---|---|---|
| `list_chats` | List all conversations | `limit?: number` |
| `get_chat` | Get message history for a chat | `chatId: string, limit?: number` |
| `search_contacts` | Search contacts by name/number | `query: string` |
| `send_message` | Send a text message | `to: string, body: string` |
| `send_file` | Send a file or image | `to: string, filePath: string, caption?: string` |
| `download_media` | Download media from a message | `messageId: string` |
| `get_connection_status` | Check if bridge is connected | — |

---

## Project Structure

```
wactl/
├── bridge/                 # Go — WhatsApp protocol bridge
│   ├── main.go             # Entry point, whatsmeow client setup
│   ├── handlers.go         # Event handlers (QR, messages, history sync)
│   ├── api.go              # Internal REST API
│   └── store.go            # SQLite operations
├── server/                 # TypeScript — MCP + admin + everything else
│   └── src/
│       ├── index.ts        # Entry point
│       ├── mcp/            # MCP JSON-RPC server + tool definitions
│       ├── admin/          # Admin panel (routes + HTML views)
│       ├── bridge/         # HTTP client for Go bridge API
│       ├── notify/         # ntfy.sh integration
│       ├── updater/        # Auto-update logic
│       └── cli/            # CLI (wactl command)
├── docker/                 # Dockerfile + docker-compose
│   ├── Dockerfile          # Multi-stage (Go builder → Node builder → runtime)
│   ├── docker-compose.yml  # Multi-account support
│   └── entrypoint.sh
├── scripts/
│   ├── install.sh          # One-command installer
│   └── update-check.sh     # Auto-updater (cron)
├── MAINTENANCE.md          # ← You should read this
├── .env.example
├── CONTRIBUTING.md
└── LICENSE
```

---

## Security

- **Admin panel** — bcrypt-hashed passwords, 24h session expiry, rate-limited login (5 attempts/min)
- **MCP endpoint** — `X-API-Key` header required on every request
- **Bridge API** — binds to `localhost:4000` only, never exposed externally
- **Data** — all messages stored locally in SQLite, nothing phones home

---

## Maintenance

wactl is built on an unofficial WhatsApp API. Things will break. That's expected.

Read **[MAINTENANCE.md](MAINTENANCE.md)** for:
- What breaks and why (spoiler: WhatsApp updates, every time)
- Known whatsmeow breaking change patterns
- The auto-updater's logic and its limits
- Manual update procedures
- Emergency playbook for "everything is down"
- Database backup and migration

---

## Troubleshooting

| Problem | Quick Fix |
|---|---|
| `Client outdated (405)` | `cd /opt/wactl/bridge && GOFLAGS="-mod=mod" go get go.mau.fi/whatsmeow@latest && go mod tidy && CGO_ENABLED=1 go build -o wactl-bridge . && cp wactl-bridge /opt/wactl/instances/<name>/wactl-bridge && systemctl restart wactl-<name>-bridge` |
| QR won't scan | Update WhatsApp on your phone. Remove a linked device if you have 4. |
| Disconnects after ~20 min | Update whatsmeow (see above). Check WhatsApp phone app is updated. |
| Build fails after update | Likely a `context.Context` parameter change — see [MAINTENANCE.md](MAINTENANCE.md#whatsmeow-breaking-changes) |
| Empty chat list | Wait 2-5 minutes after first connection for history sync |

---

## License

MIT — see [LICENSE](LICENSE).
