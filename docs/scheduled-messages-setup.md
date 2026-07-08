# Scheduled Messages — Setup Guide

This walks you through turning on **Scheduled Messages**: repeating, context-aware
WhatsApp outreach managed from a Telegram bot. Design details live in
[scheduled-messages-spec.md](scheduled-messages-spec.md); this is the operator
checklist.

> **Requirements:** a wactl instance installed the systemd way (`install.sh`, not
> Docker), the `claude` CLI on the host, an `ANTHROPIC_API_KEY`, and a Telegram
> account. Scheduled Messages is **not supported on Docker** (no cron/systemd/
> claude CLI in the image).

---

## 1. Install the `claude` CLI (host)

The runner drives Claude Code headlessly. Install it **system-wide** so the
unprivileged `wactl` user (which runs each schedule) can reach it:

```bash
curl -fsSL https://claude.ai/install.sh | sudo bash
# or: sudo npm i -g @anthropic-ai/claude-code
command -v claude   # confirm it's on PATH
```

`install.sh` records the resolved path as `CLAUDE_BIN` in each instance's `.env`.
If you install claude *after* running the wactl installer, set `CLAUDE_BIN` in the
`.env` to the absolute path (`command -v claude`).

## 2. Create the Telegram bot

1. In Telegram, open **@BotFather** → `/newbot` → follow the prompts.
2. Copy the **bot token** it gives you (`123456:ABC-...`).
3. Send BotFather `/setprivacy` → select your bot → **Disable** — so the bot can
   read normal messages in group topics, not just commands.

## 3. Create the forum group

1. Create a **new group** in Telegram, add your bot to it.
2. Open the group → **Edit** → enable **Topics** (this makes it a *forum*).
   Each schedule will get its own topic here.
3. Group settings → **Administrators** → add your bot as admin with at least
   **Manage Topics** (and Send Messages) enabled. Topic creation fails without it.

## 4. Find the group id and your user id

Add **@RawDataBot** (or @getidsbot) to the group briefly, or use the Bot API:

```bash
# after sending any message in the group:
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[].message | {chat: .chat.id, from: .from.id}'
```

- **`chat.id`** (a large negative number like `-1001234567890`) → `TELEGRAM_GROUP_ID`
- **your `from.id`** → add to `TELEGRAM_ALLOWED_USER_IDS`

> The allowlist is **fail-closed**: if `TELEGRAM_ALLOWED_USER_IDS` is empty, the
> bot ignores everyone. Only listed users, only in the configured group, are
> honored.

## 5. Configure the instance `.env`

Edit `/opt/wactl/instances/<name>/.env` and fill in:

```ini
# Runner auth — pick ONE:
#  (a) direct Anthropic:
ANTHROPIC_API_KEY=sk-ant-...
#  (b) gateway, e.g. Azure AI Foundry (leave ANTHROPIC_API_KEY blank if using this):
ANTHROPIC_BASE_URL=https://<resource>.services.ai.azure.com/anthropic
ANTHROPIC_AUTH_TOKEN=<azure-foundry-key>

TELEGRAM_BOT_TOKEN=123456:ABC-...
TELEGRAM_GROUP_ID=-1001234567890
TELEGRAM_ALLOWED_USER_IDS=11111111     # comma-separated for multiple people
# already present with defaults:
# SCHEDULE_COMPACT_TOKEN_THRESHOLD=450000
# SCHEDULE_DEFAULT_MODEL=claude-opus-4-8
# SCHEDULE_MODEL_ALLOWLIST=claude-opus-4-8
# CLAUDE_BIN=/usr/local/bin/claude
```

> **Azure AI Foundry**: the deployment must expose the Anthropic Messages API
> (`…/anthropic/v1/messages`); use the deployment name (e.g. `claude-opus-4-8`)
> as the model. The runner forces `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`
> so Claude Code's `advisor-tool` beta header (which Foundry rejects) is dropped.

Then restart the services:

```bash
sudo systemctl restart wactl-<name>-server wactl-<name>-telegram
```

The bot posts nothing until configured; once the token + group are set it
connects and starts reconciling topics. (One bot + one group **per instance**.)

## 6. Create your first schedule

Two ways — both create it **`dryRun` by default** (it will draft but never send
until you turn dryRun off):

**From Telegram** (in the group's *General* topic):
```
/new 919999900000 | Nudge the landlord for the rent receipt on the 1st, politely
```
The bot resolves the recipient, creates the schedule, and spins up its **topic**.

**From Claude.ai / Claude Code** (with the wactl MCP connected): ask it to call
`schedule_create` with a `to`, a `goal`, and a `context` (the full memory doc —
see the template in the tool description). The bot backfills a topic within ~30s.

## 7. Drive it from the schedule's topic

Open the schedule's topic and either **talk to it** ("did they reply yet?") or use
slash commands:

| | |
|---|---|
| `/status` `/log` | state, caps, last run · recent run log |
| `/context` `/setcontext <md>` | read / replace the durable memory |
| `/goal [text]` `/when [cron]` `/model [name]` | view or set |
| `/dryrun on\|off` | **off = start actually sending** |
| `/pause` `/resume` `/snooze <2h>` `/maxmsgs <n>` | throttles + kill switch |
| `/watch <criteria>` `/unwatch` | react to inbound replies |
| `/runnow` `/compact` `/reset` | run now · rotate session (save / hard) |

Lifecycle commands live in the **General** topic: `/new`, `/list`,
`/delete <slug>`, `/help`.

## 8. Go live

When you're happy with the drafts in `/log`:

```
/dryrun off
```

The schedule can now send — pinned to that one recipient, capped per run and per
day. `/pause` stops everything instantly; `/dryrun on` returns to draft-only.

---

## Upgrades

Server-side changes (including this feature) are deployed with:

```bash
sudo /opt/wactl/scripts/upgrade.sh   # git pull + rebuild bridge & server + restart
```

The daily auto-update cron only tracks the whatsmeow bridge; use `upgrade.sh` for
server/TypeScript changes.

## Troubleshooting

- **Bot silent / "idling" in logs** → `TELEGRAM_BOT_TOKEN` or `TELEGRAM_GROUP_ID`
  unset. `journalctl -u wactl-<name>-telegram -f`.
- **Bot ignores my messages** → your id isn't in `TELEGRAM_ALLOWED_USER_IDS`, or
  the message isn't in the configured group.
- **Topic creation fails** → the bot needs **Manage Topics** admin right, and the
  group must have Topics enabled.
- **Runs fail with auth errors** → `ANTHROPIC_API_KEY` unset/invalid, or `claude`
  not reachable by the `wactl` user (check `CLAUDE_BIN` in `.env`). Failures ntfy
  to the instance's topic and land in the schedule's `log.md`.
- **Nothing sends** → schedules are `dryRun` until you `/dryrun off`; also check
  `/status` for `enabled` / `snoozed` and the per-day cap.
