# Maintenance Guide

> Everything that will break, why it breaks, and how to fix it.

wactl depends on [whatsmeow](https://github.com/tulir/whatsmeow), an unofficial Go library that reverse-engineers the WhatsApp Web multi-device protocol. WhatsApp does not publish a stable API — the protocol changes without notice. This document covers every maintenance scenario you'll realistically face.

---

## Table of Contents

- [The Big Picture](#the-big-picture)
- [Routine Maintenance](#routine-maintenance)
- [Whatsmeow Breaking Changes](#whatsmeow-breaking-changes)
- [Common Failures & Fixes](#common-failures--fixes)
- [Dependency Risks](#dependency-risks)
- [Auto-Updater Deep Dive](#auto-updater-deep-dive)
- [Manual Update Procedure](#manual-update-procedure)
- [Database & Session Management](#database--session-management)
- [Monitoring Checklist](#monitoring-checklist)
- [Emergency Playbook](#emergency-playbook)

---

## The Big Picture

```
WhatsApp pushes silent protocol update
        ↓
Old whatsmeow version rejected (405 / disconnect)
        ↓
Auto-updater fetches latest whatsmeow commit
        ↓
Build succeeds?  ──→  Yes → Self-test → Swap binary → Restart
        ↓ No
Build fails (API breaking change)
        ↓
Manual code fix required in bridge/
        ↓
Fix, build, test, deploy
```

**Rule of thumb:** ~80% of outages are "update whatsmeow and rebuild." ~15% need a one-line code fix (added parameter). ~5% are deeper changes.

---

## Routine Maintenance

### Daily (automated)
- The `update-check.sh` cron runs at 3 AM (configurable via `AUTO_UPDATE_CRON`)
- It fetches the latest whatsmeow, attempts a build, self-tests on port 4099, and hot-swaps the binary
- Check logs: `cat /var/log/wactl-update.log`

### Weekly (manual, 2 minutes)
- `wactl status` — verify bridge is connected, uptime is healthy
- `tail -20 /var/log/wactl-update.log` — scan for failed updates
- Check disk usage: `du -sh /opt/wactl/data/` — SQLite databases grow over time

### Monthly (manual, 10 minutes)
- Check Go version: `go version` — if whatsmeow bumps its minimum Go version, install the new one
- Check Node.js for security patches: `node --version`
- Review whatsmeow issues: https://github.com/tulir/whatsmeow/issues — look for anything tagged as breaking

---

## Whatsmeow Breaking Changes

whatsmeow has **no tagged releases**. It uses Go pseudo-versions pinned to commit hashes (e.g., `v0.0.0-20260305215846-fc65416c22c4`). This means:

- There is no semver. No changelog. No deprecation warnings.
- `go get go.mau.fi/whatsmeow@latest` always pulls the latest commit on `main`.
- Any commit can contain breaking changes.

### Known Breaking Patterns

#### 1. `context.Context` Parameter Additions
**Frequency:** Every few months  
**Symptom:** Build fails with `too many arguments` or `not enough arguments`  
**What happens:** whatsmeow adds a `context.Context` first parameter to existing functions.  
**Fix:**
```go
// Before (old API)
container, err := sqlstore.New("sqlite3", dbPath, dbLog)
deviceStore, err := container.GetFirstDevice()
mediaData, err := client.Download(msg)

// After (new API — add context.Background() as first arg)
container, err := sqlstore.New(context.Background(), "sqlite3", dbPath, dbLog)
deviceStore, err := container.GetFirstDevice(context.Background())
mediaData, err := client.Download(context.Background(), msg)
```
**Pattern:** Check every function call to `sqlstore.New`, `container.GetFirstDevice`, `container.GetAllDevices`, `client.Download`, `client.Upload`, and `store.Contacts.GetContact`. These are the usual suspects.

#### 2. Websocket Library Swap
**Frequency:** Rare (happened once — gorilla/websocket → coder/websocket)  
**Symptom:** Build fails with import errors  
**What happens:** whatsmeow swaps its underlying websocket dependency.  
**Fix:** `go mod tidy` usually resolves it. If not, check `go.sum` for conflicting entries and delete + regenerate.

#### 3. Protobuf / Message Type Changes
**Frequency:** When WhatsApp adds new message features  
**Symptom:** Runtime panics, nil pointer dereferences on incoming messages  
**What happens:** WhatsApp protocol buffer definitions change, and whatsmeow regenerates its proto types.  
**Fix:** Update `google.golang.org/protobuf` to match what whatsmeow expects:
```bash
cd bridge/
go get google.golang.org/protobuf@latest
go mod tidy
```

#### 4. Store/Database Schema Changes
**Frequency:** Rare  
**Symptom:** Crash on startup with SQLite errors  
**What happens:** whatsmeow changes its internal database schema.  
**Fix:** Back up `data/*.db`, delete the store, re-authenticate:
```bash
systemctl stop wactl-bridge
cp /opt/wactl/data/whatsapp.db /opt/wactl/data/whatsapp.db.bak
rm /opt/wactl/data/whatsapp.db
systemctl start wactl-bridge
# Re-scan QR via admin panel
```

#### 5. Go Version Bumps
**Frequency:** ~Once a year  
**Symptom:** `go build` fails with version constraint error  
**What happens:** whatsmeow's `go.mod` declares a newer minimum Go version (has gone from 1.21 → 1.22 → 1.24 → 1.25).  
**Fix:**
```bash
# Check required version
head -3 /opt/wactl/bridge/go.mod

# Install new Go version (replace 1.25 with required version)
wget -q https://go.dev/dl/go1.25.8.linux-amd64.tar.gz -O /tmp/go.tar.gz
rm -rf /usr/local/go
tar -C /usr/local -xzf /tmp/go.tar.gz
rm /tmp/go.tar.gz
```

---

## Common Failures & Fixes

### `Client outdated (405)`
**The #1 most common issue.** WhatsApp rejects connections from old client versions.

```
[Client ERROR] Client outdated (405) connect failure
```

**Fix (auto-updater should handle this, but if it doesn't):**
```bash
cd /opt/wactl/bridge
GOFLAGS="-mod=mod" go get go.mau.fi/whatsmeow@latest
go mod tidy
CGO_ENABLED=1 go build -o wactl-bridge .
systemctl restart wactl-bridge
```

### Session Disconnects (~20 minutes)
WhatsApp drops sessions that appear idle or misbehave. Known whatsmeow issue (#818).

**Symptoms:** Bridge connects, works for 10-20 minutes, then silently disconnects.  
**Possible causes:**
- WhatsApp phone app needs updating
- Multiple linked devices competing
- Network issues / NAT timeout

**Fix:** Update whatsmeow (often patched). If persistent, check WhatsApp phone app is on the latest version and remove + re-link the device.

### QR Code Won't Scan
**Symptoms:** QR displays in admin panel but WhatsApp phone rejects it.  
**Causes:**
- WhatsApp phone app is outdated — update it
- whatsmeow is too old — update it
- Too many linked devices (max 4) — remove one in WhatsApp settings

### Bridge Starts But No Messages
**Symptoms:** Status shows connected, but `list_chats` returns empty.  
**Cause:** WhatsApp takes time to sync history on first connection.  
**Fix:** Wait 2-5 minutes. If still empty after 10 minutes, check bridge logs for sync errors.

### `CGO_ENABLED` Build Errors
**Symptoms:** `sqlite3 requires cgo` or similar.  
**Fix:**
```bash
apt-get install -y gcc build-essential sqlite3 libsqlite3-dev
CGO_ENABLED=1 go build -o wactl-bridge .
```

---

## Dependency Risks

| Dependency | Risk | Impact | Mitigation |
|---|---|---|---|
| `go.mau.fi/whatsmeow` | Protocol changes without notice | Bridge stops connecting | Auto-updater + manual fallback |
| `go.mau.fi/whatsmeow` | Maintainer abandons project | No more updates = permanent 405 | Fork the repo, track community forks |
| `coder/websocket` | Major version bump | Build failure | `go mod tidy` usually fixes |
| `go-sqlite3` (CGo) | Requires C compiler on target | Build failure on minimal systems | Install `build-essential` |
| `google.golang.org/protobuf` | Version mismatch with whatsmeow | Build or runtime errors | Always update alongside whatsmeow |
| Go toolchain | Version bumps | Can't build | Installer fetches correct version |
| Node.js 20 | EOL April 2026 | Security risk | Upgrade to Node.js 22 LTS when ready |
| WhatsApp Web protocol | Changes without notice | Everything breaks | This is the fundamental risk of the project |
| `ntfy.sh` | Service goes down | No push notifications | Self-host ntfy if critical |

### The Nuclear Scenario
If WhatsApp fundamentally changes its multi-device architecture or actively blocks unofficial clients, whatsmeow (and every project depending on it) dies. There is no fix for this. It's an unofficial API — always has been.

**Mitigation:** Keep your data exportable. The SQLite database contains your message history. If wactl dies, your data doesn't.

---

## Auto-Updater Deep Dive

The update-check script (`scripts/update-check.sh`) runs daily and does the following:

```
1. Read current whatsmeow version from go.mod
2. Fetch latest: go get go.mau.fi/whatsmeow@latest
3. If same version → exit (nothing to do)
4. If different → attempt build
5. If build fails → rollback go.mod/go.sum, exit with error
6. If build succeeds → self-test on port 4099
7. If self-test passes → swap binary, restart service
8. If self-test fails → rollback everything
```

### When the auto-updater can't save you
- **API breaking changes** (new parameters) — build fails, updater rolls back. You need to edit Go code.
- **Go version bump** — build fails because the system Go is too old. You need to install a newer Go.
- **Node.js breaking changes** — the updater only touches the Go bridge, not the TS server.

### Auto-updater logs
```bash
# View update history
cat /var/log/wactl-update.log

# Watch in real time
tail -f /var/log/wactl-update.log

# Check if last update succeeded
tail -5 /var/log/wactl-update.log
```

---

## Manual Update Procedure

When the auto-updater fails and you need to intervene:

```bash
# 1. SSH into your server
ssh user@your-server

# 2. Stop services
sudo systemctl stop wactl-bridge wactl-server

# 3. Pull latest code
cd /opt/wactl
sudo git pull

# 4. Update whatsmeow
cd bridge/
sudo GOFLAGS="-mod=mod" go get go.mau.fi/whatsmeow@latest
sudo go mod tidy

# 5. Try building
sudo CGO_ENABLED=1 go build -o wactl-bridge .

# 6. If build fails, check the error:
#    - "too many arguments" / "not enough arguments" → context.Context change (see above)
#    - "cannot find module" → go mod tidy, or check Go version
#    - "undefined: SomeType" → protobuf change, update protobuf dep

# 7. After successful build, rebuild TS server too (if needed)
cd ../server
sudo npm ci
sudo npm run build

# 8. Restart
sudo systemctl start wactl-bridge wactl-server

# 9. Verify
wactl status
```

---

## Database & Session Management

### SQLite Files
```
/opt/wactl/data/
├── whatsapp.db          # whatsmeow session + device keys
├── messages.db          # Message history (wactl's own store)
└── test/                # Auto-updater self-test data (temporary)
```

### Backup
```bash
# Hot backup (safe while running)
sqlite3 /opt/wactl/data/whatsapp.db ".backup '/opt/wactl/data/whatsapp.db.bak'"
sqlite3 /opt/wactl/data/messages.db ".backup '/opt/wactl/data/messages.db.bak'"
```

### Session Reset
If the WhatsApp session is corrupted (persistent auth failures):
```bash
sudo systemctl stop wactl-bridge
rm /opt/wactl/data/whatsapp.db
sudo systemctl start wactl-bridge
# Re-scan QR code via admin panel at http://<server-ip>:8080
```

### Database Growth
Messages accumulate indefinitely. For a moderately active account, expect ~50-100 MB/year. If disk becomes a concern:
```bash
# Check size
du -sh /opt/wactl/data/*.db

# Vacuum (reclaim space from deleted records)
sqlite3 /opt/wactl/data/messages.db "VACUUM;"
```

---

## Monitoring Checklist

### Health Checks
```bash
# Is the bridge alive?
curl -s http://127.0.0.1:4000/status | python3 -m json.tool

# Is the MCP server alive?
curl -s http://127.0.0.1:3000/health

# Are systemd services running?
systemctl status wactl-bridge wactl-server
```

### Log Locations
| Log | Location | Command |
|-----|----------|---------|
| Bridge logs | journald | `journalctl -u wactl-bridge -f` |
| Server logs | journald | `journalctl -u wactl-server -f` |
| Update logs | File | `tail -f /var/log/wactl-update.log` |
| Combined | CLI | `wactl logs` |

### Alerts to Set Up
If you're running this in production, consider monitoring:
1. **Bridge disconnect** — poll `http://127.0.0.1:4000/status` every 5 minutes
2. **Update failures** — grep `/var/log/wactl-update.log` for "FAILED" or "reverting"
3. **Disk space** — alert at 90% on the data partition
4. **Service restarts** — `systemctl show wactl-bridge -p NRestarts`

---

## Emergency Playbook

### "Everything is down and I need it working NOW"

```bash
# 1. Check what's actually broken
sudo systemctl status wactl-bridge wactl-server

# 2. Check bridge logs for the real error
sudo journalctl -u wactl-bridge --since "10 minutes ago" --no-pager

# 3. If "Client outdated (405)" — update whatsmeow
cd /opt/wactl/bridge
sudo GOFLAGS="-mod=mod" go get go.mau.fi/whatsmeow@latest
sudo go mod tidy
sudo CGO_ENABLED=1 go build -o wactl-bridge .
sudo systemctl restart wactl-bridge wactl-server

# 4. If build fails — check the error message and fix accordingly (see "Known Breaking Patterns")

# 5. If nothing works — full reset
sudo systemctl stop wactl-bridge wactl-server
cd /opt/wactl
sudo git stash  # save any local changes
sudo git pull origin main
cd bridge/
sudo GOFLAGS="-mod=mod" go get go.mau.fi/whatsmeow@latest
sudo go mod tidy
sudo CGO_ENABLED=1 go build -o wactl-bridge .
cd ../server
sudo npm ci && sudo npm run build
sudo systemctl start wactl-bridge wactl-server

# 6. If STILL broken — check if whatsmeow itself is broken
#    Go to https://github.com/tulir/whatsmeow/issues
#    Search for recent issues mentioning "405" or "outdated"
#    If many people are reporting it, the fix hasn't been pushed yet. Wait.
```

### "I need to move to a new server"

```bash
# On old server: backup
tar czf wactl-backup.tar.gz /opt/wactl/data/ /opt/wactl/.env

# On new server: install fresh
curl -fsSL https://raw.githubusercontent.com/patildhruv/wactl/main/scripts/install.sh | sudo bash

# Restore data (keeps your session alive — no QR re-scan)
sudo systemctl stop wactl-bridge wactl-server
sudo tar xzf wactl-backup.tar.gz -C /
sudo systemctl start wactl-bridge wactl-server
```

---

## Future-Proofing Notes

1. **Node.js 20 LTS** reaches end-of-life in April 2026. Plan to upgrade to Node.js 22 LTS. Update the install script, Dockerfile, and test.

2. **Go modules proxy caching** — The Go module proxy (`proxy.golang.org`) caches modules. If whatsmeow pushes a critical fix, there can be a delay (usually <30 minutes) before `@latest` resolves to the new commit.

3. **WhatsApp usernames** — Meta is rolling out WhatsApp usernames and BSUID (business-scoped user IDs) in 2026. If WhatsApp changes how contacts are identified (phone number → username), the contact lookup and message routing in the bridge will need updating.

4. **Multi-device limits** — WhatsApp currently allows 4 linked devices. If they reduce this, you may get forced disconnects.

5. **Rate limiting** — WhatsApp has undocumented rate limits on the Web API. Sending too many messages too fast can get your number temporarily banned. There's no official documentation on the limits — be conservative.

6. **End-to-end encryption changes** — If WhatsApp changes its E2E encryption protocol (Signal Protocol → something else), whatsmeow would need a significant rewrite. Low probability but catastrophic impact.

---

_Last updated: March 2026_
