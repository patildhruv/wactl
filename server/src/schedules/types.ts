/**
 * Scheduled-messages data model. See docs/scheduled-messages-spec.md §4.
 *
 * `Schedule` is durable config (schedule.json). `SendState` is runtime send
 * accounting kept in a sibling send-state.json — deliberately separate so the
 * config file and the counters never contend on a write (spec §9).
 */

/** A watch arms the schedule to react to inbound activity on `watchTarget`. */
export interface ScheduleWatch {
  /** Chat being observed — MAY be a @g.us group, MAY differ from the send target (spec §4). */
  watchTarget: { identity: string; jid: string };
  /** Free-text relevance criteria the agent judges inbound against. */
  criteria: string;
  /** Unix seconds — poll/react to messages at or after this; advanced each run. */
  since: number;
}

export interface Schedule {
  slug: string;
  /** Current Claude Code session uuid; swapped on compact/reset. */
  sessionId: string;
  /** Per-schedule model (/model), e.g. "claude-opus-4-8". MUST be in the allowlist. */
  model: string;

  // --- Send target (single pinned recipient; decoupled from watchTarget) ---
  /** Canonical identity (bare user-part / phone) — the source of truth. */
  toIdentity: string;
  /** Cached resolved JID; may go stale under LID migration → re-resolve. */
  toJid: string;
  toResolvedAt: number;

  cron: string | null;          // null = watch-only
  goal: string;
  enabled: boolean;             // hard kill switch
  dryRun: boolean;              // true = agent never gets the send tool
  maxMsgs: number;              // per-run send cap (server-enforced)
  perDayMax: number;            // per-day send ceiling (server-enforced)
  checkMessages: boolean;       // pull recent msgs before drafting
  watch: ScheduleWatch | null;
  snoozeUntil: number | null;   // suppress runs until this epoch (seconds)
  telegramTopicId: number | null; // reconciled by wactl-telegram
  contextHash: string;          // sha256 of context.md as the session last saw it
  sessionStarted: boolean;      // false until the first run creates the transcript; reset on rotate
  lastRun: number | null;
  createdAt: number;
}

export interface SendState {
  day: string;                  // YYYY-MM-DD (UTC) the counter belongs to
  sentToday: number;
  /** Minted by the runner at run start; a send is only allowed within a live run. */
  activeRun: { token: string; expiresAt: number; sent: number } | null;
}

export interface CreateScheduleInput {
  to: string;                   // phone / JID / contact name to resolve
  goal: string;
  cron?: string | null;
  model?: string;
  checkMessages?: boolean;
  maxMsgs?: number;
  perDayMax?: number;
  dryRun?: boolean;
  /** Full context.md markdown; if omitted, a placeholder template is seeded. */
  context?: string;
}
