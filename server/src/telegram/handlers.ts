/**
 * Telegram command handlers. Two kinds:
 *  - store commands: mutate/read schedule state in-process (instant, no claude).
 *  - runner commands: free-text messages + /runnow spawn schedule-run.sh so the
 *    agent (with the schedule's resumed session) produces the reply.
 *
 * Handlers are deliberately thin and return a reply string (or a RunRequest the
 * service fulfils asynchronously), so this module has no telegram/network deps
 * and is unit-testable with the real store on a temp DATA_DIR.
 */

import {
  listSchedules,
  getSchedule,
  updateSchedule,
  deleteSchedule,
  getContext,
  setContext,
  getLogTail,
  requestRunNow,
  requestRotation,
  validateModel,
  ORCHESTRATOR_SLUG,
} from "../schedules/store";
import { Schedule } from "../schedules/types";

/** Escape text for Telegram HTML parse mode (only & < > need escaping). */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const code = (s: string) => `<code>${esc(s)}</code>`;
const b = (s: string) => `<b>${esc(s)}</b>`;
const pre = (s: string) => `<pre>${esc(s)}</pre>`;

/**
 * Convert the agent's freeform Markdown into the small HTML subset Telegram
 * renders (<b> <i> <code> <pre> <a> <blockquote>). Agent replies are Markdown;
 * sent as plain text the operator sees raw `**` and backtick markers. Code
 * spans/blocks are pulled out first (so their contents aren't mangled), the rest
 * is HTML-escaped, then inline markers become tags. Unrecognized markup simply
 * survives as escaped text. safeSend still falls back to plain on any HTML error.
 */
export function mdToTelegramHtml(md: string): string {
  const blocks: string[] = [];
  const spans: string[] = [];
  const B = "\uF8FF"; // private-use sentinels — won't collide with real text
  const C = "\uF8FE";
  let s = md;
  // Fenced code blocks first (strip the optional language, keep the body).
  s = s.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_m, codeBody) => {
    blocks.push(String(codeBody).replace(/\n$/, ""));
    return `${B}${blocks.length - 1}${B}`;
  });
  // Inline code.
  s = s.replace(/`([^`\n]+)`/g, (_m, codeBody) => {
    spans.push(String(codeBody));
    return `${C}${spans.length - 1}${C}`;
  });
  // Escape the remaining prose (so agent text can't inject HTML).
  s = esc(s);
  // Links [text](url) — url already escaped as part of the prose.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => `<a href="${u}">${t}</a>`);
  // Bold (** or __), then italic (single * or _), then headings → bold.
  s = s.replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^\n]+?)__/g, "<b>$1</b>");
  s = s.replace(/(^|[^*])\*(?!\s)([^*\n]+?)\*/g, "$1<i>$2</i>");
  s = s.replace(/^\s{0,3}#{1,6}\s+(.+?)\s*$/gm, "<b>$1</b>");
  // Blockquotes ("> " is "&gt; " after escaping) and bullets.
  s = s.replace(/^\s{0,3}&gt;\s?(.*)$/gm, "<blockquote>$1</blockquote>");
  s = s.replace(/^(\s*)[-*+]\s+/gm, "$1• ");
  // Reinsert protected code as tags (escaping their contents now).
  s = s.replace(new RegExp(C + "(\\d+)" + C, "g"), (_m, i) => `<code>${esc(spans[+i])}</code>`);
  s = s.replace(new RegExp(B + "(\\d+)" + B, "g"), (_m, i) => `<pre>${esc(blocks[+i])}</pre>`);
  return s;
}

/** The command menu (autocomplete on "/"). Union of general + topic commands. */
export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: "new", description: "Create a schedule: /new <contact> | <goal>" },
  { command: "list", description: "List all schedules" },
  { command: "delete", description: "Delete a schedule: /delete <slug>" },
  { command: "status", description: "This schedule's status" },
  { command: "log", description: "Recent run log" },
  { command: "context", description: "Show durable memory (context.md)" },
  { command: "setcontext", description: "Replace memory: /setcontext <text>" },
  { command: "goal", description: "View/set goal: /goal [text]" },
  { command: "when", description: "View/set cron: /when [expr]" },
  { command: "model", description: "View/set model: /model [name]" },
  { command: "dryrun", description: "Toggle sending: /dryrun on|off" },
  { command: "pause", description: "Suspend runs (kill switch)" },
  { command: "resume", description: "Re-enable runs" },
  { command: "snooze", description: "Suppress runs: /snooze <2h>" },
  { command: "maxmsgs", description: "Per-run send cap: /maxmsgs <n>" },
  { command: "watch", description: "React to replies: /watch <criteria>" },
  { command: "unwatch", description: "Stop watching" },
  { command: "runnow", description: "Run now" },
  { command: "compact", description: "Save memory, fresh session" },
  { command: "reset", description: "Fresh session (discard buffer)" },
  { command: "help", description: "Show commands" },
];

/** Find the schedule bound to a Telegram topic, or null. */
export function scheduleForTopic(threadId: number): Schedule | null {
  return listSchedules().find((s) => s.telegramTopicId === threadId) || null;
}

/**
 * Which topic ids belong to deleted schedules and are safe to close.
 *
 * Pure set arithmetic so the guards are testable without touching Telegram —
 * closing the wrong topic is destructive-ish (reversible, but visible to the
 * operator), so each exclusion below is deliberate:
 *  - id <= 1: topic 1 is the forum's General topic. It is not a per-schedule
 *    topic, Telegram won't close it, and the orchestrator lives there.
 *  - orchestrator slug: a reserved pseudo-schedule, never a disposable topic.
 *  - any id a live schedule still holds: a slug can be deleted and recreated,
 *    and the trash keeps the OLD record — so never close an id still in use.
 */
export function orphanedTopicIds(
  liveTopicIds: (number | null | undefined)[],
  trashed: { slug: string; telegramTopicId: number }[]
): number[] {
  const live = new Set(liveTopicIds.filter((n): n is number => typeof n === "number"));
  const seen = new Set<number>();
  const out: number[] = [];
  for (const t of trashed) {
    const id = t.telegramTopicId;
    if (typeof id !== "number" || !Number.isFinite(id)) continue;
    if (id <= 1) continue;
    if (t.slug === ORCHESTRATOR_SLUG) continue;
    if (live.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Parse a human duration ("2h", "30m", "1d", "45") into seconds. */
export function parseDuration(s: string): number | null {
  const m = s.trim().match(/^(\d+)\s*([smhd]?)$/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = (m[2] || "m").toLowerCase();
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit]!;
  return n * mult;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export interface RunRequest {
  kind: "run";
  slug: string;
  event: "telegram" | "runnow";
  payload?: string;
  ack: string; // posted immediately before the (slow) run
}

export type HandlerResult = { kind: "reply"; text: string } | RunRequest;

function reply(text: string): HandlerResult {
  return { kind: "reply", text };
}

/** A finished `schedule-run.sh` process, as the Telegram service sees it. */
export interface RunnerOutcome {
  code: number | null; // null = killed by a signal
  stdout: string;
  stderr: string;
}

/** Cap on error text pasted into a Telegram message; the journal gets the whole thing. */
const RUNNER_ERR_MAX = 400;

/** Last non-empty line of a stream, trimmed and capped. */
function lastLine(s: string, max = RUNNER_ERR_MAX): string {
  const line = s.split("\n").map((l) => l.trim()).filter(Boolean).pop() || "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * Decide what the operator sees when a runner process finishes.
 *
 * The runner prints one JSON line on success and, on failure, exits non-zero
 * with the reason on stderr. The service used to read stdout ONLY, so every
 * failure — dead gateway, retired model, crashed script — rendered as the bare
 * "(done)" fallback with nothing logged; that silence hid a multi-day outage.
 * A non-zero exit or unreadable stdout must now surface to the topic AND come
 * back as a `failure` string for the caller to log. `failure` is null on success.
 */
export function formatRunnerOutcome(o: RunnerOutcome): { text: string; failure: string | null } {
  const stdout = (o.stdout || "").trim();
  const stderr = (o.stderr || "").trim();
  const failed = o.code !== 0;

  let parsed: { reply?: unknown; result?: unknown } | null = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout.split("\n").pop() || "");
    } catch {
      parsed = null; // fall through to the failure path below
    }
  }

  if (!failed && parsed) {
    const text = parsed.reply || parsed.result;
    if (text) return { text: String(text), failure: null };
    // Ran fine with nothing to say: a compact/reset, or a watch tick with no new inbound.
    return { text: "(done)", failure: null };
  }

  const why = lastLine(stderr) || lastLine(stdout) || "no output on either stream";
  const label = failed ? `exit ${o.code === null ? "signal" : o.code}` : "unreadable output";
  return {
    text: `⚠️ run failed (${label}): ${why}`,
    failure: `${label} — stderr: ${stderr || "(empty)"} | stdout: ${stdout || "(empty)"}`,
  };
}

function fmtStatus(s: Schedule): string {
  const flags = [
    s.enabled ? "✅ enabled" : "⛔ DISABLED",
    s.dryRun ? "🧪 dryRun" : "🔴 LIVE",
    s.watch ? `👀 watching` : null,
    s.snoozeUntil && s.snoozeUntil > nowSec() ? `😴 snoozed` : null,
  ].filter(Boolean) as string[];
  return [
    `📋 ${b(s.slug)}`,
    `${b("to")} ${code(s.toIdentity)}   ${b("model")} ${code(s.model)}`,
    `${b("cron")} ${code(s.cron || "(watch-only)")}   ${b("caps")} ${s.maxMsgs}/run · ${s.perDayMax}/day`,
    `${b("state")} ${flags.join(" · ")}`,
    s.watch ? `${b("watch")} ${esc(s.watch.criteria)}` : "",
    `${b("goal")} ${esc(s.goal)}`,
    s.lastRun ? `${b("last run")} ${esc(new Date(s.lastRun * 1000).toISOString())}` : `${b("last run")} never`,
  ].filter(Boolean).join("\n");
}

/**
 * Handle a slash command already routed to a topic's schedule. `sched` is the
 * schedule bound to that topic. Returns a reply or a RunRequest.
 */
export function handleTopicCommand(sched: Schedule, command: string, args: string): HandlerResult {
  const slug = sched.slug;
  try {
    switch (command) {
      case "status":
        return reply(fmtStatus(getSchedule(slug)));
      case "help":
        return reply(TOPIC_HELP);
      case "pause":
        updateSchedule(slug, { enabled: false });
        return reply("⏸️ paused — runs are suspended (kill switch). /resume to re-enable.");
      case "resume":
        updateSchedule(slug, { enabled: true });
        return reply("▶️ resumed.");
      case "dryrun": {
        const on = /^on|true|1$/i.test(args.trim());
        const off = /^off|false|0$/i.test(args.trim());
        if (!on && !off) return reply(`usage: ${code("/dryrun on|off")}`);
        updateSchedule(slug, { dryRun: on });
        return reply(on ? "🧪 dryRun " + b("ON") + " — will draft to log, not send." : "🔴 dryRun " + b("OFF") + " — this schedule can now SEND.");
      }
      case "maxmsgs": {
        const n = parseInt(args.trim(), 10);
        if (!Number.isFinite(n) || n < 0) return reply(`usage: ${code("/maxmsgs <n>")}`);
        updateSchedule(slug, { maxMsgs: n });
        return reply(`per-run cap set to ${b(String(n))}.`);
      }
      case "snooze": {
        const secs = parseDuration(args);
        if (secs === null) return reply(`usage: ${code("/snooze <dur>")} e.g. 2h, 30m, 1d`);
        updateSchedule(slug, { snoozeUntil: nowSec() + secs });
        return reply(`😴 snoozed for ${b(esc(args.trim()))} (until ${code(new Date((nowSec() + secs) * 1000).toISOString())}).`);
      }
      case "when": {
        if (!args.trim()) return reply(`cron: ${code(sched.cron || "(watch-only)")}`);
        updateSchedule(slug, { cron: args.trim() });
        return reply(`⏰ cadence set to ${code(args.trim())}.`);
      }
      case "goal": {
        if (!args.trim()) return reply(`${b("goal")} ${esc(sched.goal)}`);
        updateSchedule(slug, { goal: args.trim() });
        return reply("🎯 goal updated.");
      }
      case "model": {
        if (!args.trim()) return reply(`${b("model")} ${code(sched.model)}`);
        try {
          validateModel(args.trim());
        } catch (e) {
          return reply(`❌ ${esc((e as Error).message)}`);
        }
        updateSchedule(slug, { model: args.trim() });
        return reply(`🧠 model set to ${code(args.trim())}.`);
      }
      case "context":
        return reply(`📄 ${b("context.md")}\n${pre(getContext(slug) || "(empty)")}`);
      case "setcontext":
        if (!args.trim()) return reply(`usage: ${code("/setcontext <full new context.md>")}`);
        setContext(slug, args);
        return reply("💾 context.md replaced — next run will pick it up.");
      case "log":
        return reply(`🧾 ${b("recent log")}\n${pre(getLogTail(slug) || "(empty)")}`);
      case "watch": {
        if (!args.trim()) return reply(`usage: ${code("/watch <criteria>")}`);
        updateSchedule(slug, {
          watch: { watchTarget: { identity: sched.toIdentity, jid: sched.toJid }, criteria: args.trim(), since: nowSec() },
        });
        return reply(`👀 watching for: ${b(esc(args.trim()))} (on ${code(sched.toIdentity)}).`);
      }
      case "unwatch":
        updateSchedule(slug, { watch: null });
        return reply("🚫 watch cleared.");
      case "compact":
        requestRotation(slug, "compact");
        return reply("🧹 compaction queued — memory will be saved to context.md and a fresh session started on the next tick.");
      case "reset":
        requestRotation(slug, "reset");
        return reply("♻️ reset queued — fresh session from current context.md (unsaved session state discarded) on the next tick.");
      case "runnow":
        return { kind: "run", slug, event: "runnow", ack: "⏳ running now…" };
      case "delete":
        return reply(`to delete, use ${code("/delete <slug>")} in the General topic (it also closes this topic).`);
      default:
        return reply(`unknown command /${esc(command)} — /help for the list.`);
    }
  } catch (e) {
    return reply(`❌ ${esc((e as Error).message)}`);
  }
}

/** A free-text message in a topic → resume the schedule's session with it. */
export function handleTopicMessage(sched: Schedule, text: string): RunRequest {
  return { kind: "run", slug: sched.slug, event: "telegram", payload: text, ack: "⏳ …" };
}

export const TOPIC_HELP = [
  b("Commands for this schedule"),
  "",
  `${code("/status")} · ${code("/log")} · ${code("/context")} · ${code("/setcontext <md>")}`,
  `${code("/dryrun on|off")} · ${code("/pause")} · ${code("/resume")} · ${code("/snooze <2h>")} · ${code("/maxmsgs <n>")}`,
  `${code("/when [cron]")} · ${code("/goal [text]")} · ${code("/model [name]")}`,
  `${code("/watch <criteria>")} · ${code("/unwatch")} · ${code("/runnow")} · ${code("/compact")} · ${code("/reset")}`,
  "",
  "…or just <i>talk</i> to me — I'll act with this schedule's memory.",
].join("\n");

export const GENERAL_HELP = [
  b("wactl · scheduled messages"),
  "",
  `${code("/new <contact> | <goal>")}  — create a schedule (dryRun by default)`,
  `${code("/list")}  — all schedules`,
  `${code("/delete <slug>")}  — delete a schedule + close its topic`,
  "",
  "Or just <i>talk to me here</i> — I'm the orchestrator: I can study a contact's chats, then design and create schedules for you. Each gets its own topic to manage it.",
].join("\n");
