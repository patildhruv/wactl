#!/bin/bash
# wactl upstream watcher — polls whatsmeow + mautrix-whatsapp for protocol
# changes and pings each instance's ntfy topic when something interesting lands.
#
# Interesting = commit/release whose title matches KEYWORD_RE. The keywords are
# tuned for the kinds of shifts that silently break wactl (e.g., LID migration,
# identity-key format changes, session replacement, protocol-handshake churn).
#
# Meant to run daily via cron (see /etc/cron.d/wactl-upstream-watch). State is
# kept in STATE_FILE so re-runs only alert on new material.

set -e

INSTALL_DIR="${INSTALL_DIR:-/opt/wactl}"
INSTANCES_JSON="$INSTALL_DIR/instances.json"
STATE_FILE="$INSTALL_DIR/.upstream-watch-state"
LOG_PREFIX="[wactl-upstream $(date -Iseconds)]"

KEYWORD_RE='lid|identity|protocol|breaking|ratchet|session|pair|auth|migrate|migration|token|prekey|handshake|multi-device|multidevice|companion|pn-|s\.whatsapp\.net|deprecat|remove|replace'

WHATSMEOW_REPO="tulir/whatsmeow"
MAUTRIX_REPO="mautrix/whatsapp"
BRIDGE_GOMOD="$INSTALL_DIR/bridge/go.mod"

echo "$LOG_PREFIX Starting upstream watch..."

if [ ! -f "$INSTANCES_JSON" ]; then
  echo "$LOG_PREFIX No instances.json — nothing to watch for."
  exit 0
fi

# Pull the whatsmeow SHA currently pinned in the deployed bridge's go.mod. The
# pseudo-version looks like "v0.0.0-20260511155711-eb05d94dea7d"; the trailing
# 12 hex chars are the short commit SHA. Used as the baseline so we never
# re-alert on commits the 03:00 cron-update already pulled and deployed
# earlier the same day.
DEPLOYED_SHA=""
if [ -f "$BRIDGE_GOMOD" ]; then
  PSEUDO=$(grep -E '^[[:space:]]*go\.mau\.fi/whatsmeow' "$BRIDGE_GOMOD" | awk '{print $2}')
  if [[ "$PSEUDO" =~ -([0-9a-f]{12})$ ]]; then
    DEPLOYED_SHA="${BASH_REMATCH[1]}"
    echo "$LOG_PREFIX Deployed whatsmeow SHA: $DEPLOYED_SHA"
  fi
fi

# Load prior state (shell-safe key=value lines).
WHATSMEOW_LAST_SHA=""
MAUTRIX_LAST_RELEASE=""
if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  . "$STATE_FILE"
fi

# --- Helpers ---------------------------------------------------------------

# notify <title> <priority> <body>
#
# Fans out a ntfy message to every instance that has a topic configured. Each
# instance can point at a different ntfy server (self-hosted vs public), so we
# read server + topic per-instance rather than assuming a shared endpoint.
notify() {
  local title="$1"
  local priority="$2"
  local body="$3"
  local tags="${4:-warning,mag}"

  jq -r '.instances | to_entries[] | .key' "$INSTANCES_JSON" | while read -r INST; do
    local env_file="$INSTALL_DIR/instances/$INST/.env"
    [ -f "$env_file" ] || continue
    local topic server
    topic=$(grep '^NTFY_TOPIC=' "$env_file" 2>/dev/null | cut -d= -f2-)
    server=$(grep '^NTFY_SERVER=' "$env_file" 2>/dev/null | cut -d= -f2-)
    server="${server:-https://ntfy.sh}"
    [ -n "$topic" ] || continue
    curl -s --max-time 10 \
      -H "Title: $title" \
      -H "Priority: $priority" \
      -H "Tags: $tags" \
      -d "$body" \
      "$server/$topic" > /dev/null 2>&1 || true
  done
}

# github_get <path> — fetch a GitHub API endpoint with optional token auth.
# Token comes from $GITHUB_TOKEN (unauthenticated works but hits a 60/hour
# rate limit shared across the whole box).
github_get() {
  local path="$1"
  local auth=()
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  fi
  curl -sSL --max-time 15 \
    -H "Accept: application/vnd.github+json" \
    -H "User-Agent: wactl-upstream-watch" \
    "${auth[@]}" \
    "https://api.github.com$path"
}

# write_state — persist the latest SHAs so the next run is incremental.
write_state() {
  cat > "$STATE_FILE" <<EOF
WHATSMEOW_LAST_SHA="$WHATSMEOW_LAST_SHA"
MAUTRIX_LAST_RELEASE="$MAUTRIX_LAST_RELEASE"
EOF
}

# --- Whatsmeow commits -----------------------------------------------------

echo "$LOG_PREFIX Polling $WHATSMEOW_REPO commits..."
WHATSMEOW_JSON=$(github_get "/repos/$WHATSMEOW_REPO/commits?per_page=30" || echo "")

if [ -z "$WHATSMEOW_JSON" ] || ! echo "$WHATSMEOW_JSON" | jq -e 'type == "array"' > /dev/null 2>&1; then
  echo "$LOG_PREFIX whatsmeow fetch failed or rate-limited, skipping."
else
  LATEST_SHA=$(echo "$WHATSMEOW_JSON" | jq -r '.[0].sha')

  # Baseline = whichever short-SHA we trust most.
  # Prefer the deployed bridge's pinned SHA over the state file, since the
  # 03:00 cron-update may have deployed past whatever this script last saw —
  # alerting again on those commits would be duplicate noise. State file is a
  # fallback for pre-existing installs where go.mod isn't readable.
  BASELINE_SHA="${DEPLOYED_SHA:-${WHATSMEOW_LAST_SHA:0:12}}"
  LATEST_SHORT="${LATEST_SHA:0:12}"

  if [ -z "$BASELINE_SHA" ]; then
    # First run, no go.mod — seed state without alerting (avoid backlog ping).
    WHATSMEOW_LAST_SHA="$LATEST_SHA"
    echo "$LOG_PREFIX Seeded whatsmeow state to $LATEST_SHA (no alert on first run)."
  elif [ "$LATEST_SHORT" = "$BASELINE_SHA" ]; then
    echo "$LOG_PREFIX whatsmeow: no new commits (baseline=$BASELINE_SHA)."
  else
    # Pull titles of every commit between BASELINE and HEAD, filter by keywords.
    # GitHub returns 40-char SHAs; we slice to 12 chars on both sides so the
    # index() lookup matches the short SHA we derived from go.mod.
    NEW_COMMITS=$(echo "$WHATSMEOW_JSON" | jq -r \
      --arg last "$BASELINE_SHA" \
      '.[0:(map(.sha[0:12]) | index($last) // 30)] | .[] | "\(.sha[0:7])  \(.commit.message | split("\n")[0])"')

    if [ -z "$NEW_COMMITS" ]; then
      echo "$LOG_PREFIX whatsmeow: baseline $BASELINE_SHA not in recent 30, assuming caught up."
    else
      INTERESTING=$(echo "$NEW_COMMITS" | grep -iE "$KEYWORD_RE" || true)
      TOTAL=$(echo "$NEW_COMMITS" | wc -l)
      echo "$LOG_PREFIX whatsmeow: $TOTAL new commits since deployed $BASELINE_SHA"

      if [ -n "$INTERESTING" ]; then
        BODY="ACTION: review commits, watch for silent breakage (check get_chat on active 1:1s).

$(echo "$INTERESTING" | head -10)

$TOTAL commits since deployed $BASELINE_SHA. Review: https://github.com/$WHATSMEOW_REPO/commits"
        notify "🚨 wactl — whatsmeow: protocol-relevant commits" "high" "$BODY" "rotating_light,mag"
        echo "$LOG_PREFIX Alerted on $(echo "$INTERESTING" | wc -l) keyword-matching commits."
      fi
    fi

    WHATSMEOW_LAST_SHA="$LATEST_SHA"
  fi
fi

# --- Mautrix-whatsapp releases --------------------------------------------

# mautrix-whatsapp ships tagged releases with changelogs. They usually react to
# protocol changes a day or two before whatsmeow commits surface — treat this as
# an independent signal, not a duplicate of the commit feed.
echo "$LOG_PREFIX Polling $MAUTRIX_REPO latest release..."
MAUTRIX_JSON=$(github_get "/repos/$MAUTRIX_REPO/releases/latest" || echo "")

if [ -z "$MAUTRIX_JSON" ] || ! echo "$MAUTRIX_JSON" | jq -e '.tag_name' > /dev/null 2>&1; then
  echo "$LOG_PREFIX mautrix fetch failed, skipping."
else
  LATEST_TAG=$(echo "$MAUTRIX_JSON" | jq -r '.tag_name')

  if [ -z "$MAUTRIX_LAST_RELEASE" ]; then
    MAUTRIX_LAST_RELEASE="$LATEST_TAG"
    echo "$LOG_PREFIX Seeded mautrix state to $LATEST_TAG."
  elif [ "$LATEST_TAG" = "$MAUTRIX_LAST_RELEASE" ]; then
    echo "$LOG_PREFIX mautrix: still on $LATEST_TAG."
  else
    BODY_RAW=$(echo "$MAUTRIX_JSON" | jq -r '.body // ""')
    # Keep only lines that look like changelog bullets and mention anything relevant.
    INTERESTING=$(echo "$BODY_RAW" | grep -iE "$KEYWORD_RE" | head -10 || true)

    if [ -n "$INTERESTING" ]; then
      BODY="ACTION: read changelog — mautrix often reacts to protocol shifts a day or two before whatsmeow.

New $MAUTRIX_REPO release: $LATEST_TAG (was $MAUTRIX_LAST_RELEASE)

$INTERESTING

Full notes: https://github.com/$MAUTRIX_REPO/releases/tag/$LATEST_TAG"
      notify "📣 wactl — mautrix-whatsapp: $LATEST_TAG has protocol notes" "high" "$BODY" "loudspeaker,whatsapp"
      echo "$LOG_PREFIX Alerted on mautrix release $LATEST_TAG."
    else
      echo "$LOG_PREFIX mautrix $LATEST_TAG: no keyword matches in changelog, silent update."
    fi

    MAUTRIX_LAST_RELEASE="$LATEST_TAG"
  fi
fi

write_state
echo "$LOG_PREFIX Done."
