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
} from "../schedules/store";
import { Schedule } from "../schedules/types";

/** Find the schedule bound to a Telegram topic, or null. */
export function scheduleForTopic(threadId: number): Schedule | null {
  return listSchedules().find((s) => s.telegramTopicId === threadId) || null;
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

function fmtStatus(s: Schedule): string {
  const flags = [
    s.enabled ? "enabled" : "DISABLED",
    s.dryRun ? "dryRun" : "LIVE",
    s.watch ? `watching:"${s.watch.criteria}"` : null,
    s.snoozeUntil && s.snoozeUntil > nowSec() ? `snoozed→${new Date(s.snoozeUntil * 1000).toISOString()}` : null,
  ].filter(Boolean);
  return [
    `📋 ${s.slug}`,
    `to: ${s.toIdentity}   model: ${s.model}`,
    `cron: ${s.cron || "(watch-only)"}   caps: ${s.maxMsgs}/run, ${s.perDayMax}/day`,
    `state: ${flags.join(" · ")}`,
    `goal: ${s.goal}`,
    s.lastRun ? `last run: ${new Date(s.lastRun * 1000).toISOString()}` : "last run: never",
  ].join("\n");
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
        if (!on && !off) return reply("usage: /dryrun on|off");
        updateSchedule(slug, { dryRun: on });
        return reply(on ? "🧪 dryRun ON — will draft to log, not send." : "✅ dryRun OFF — this schedule can now SEND.");
      }
      case "maxmsgs": {
        const n = parseInt(args.trim(), 10);
        if (!Number.isFinite(n) || n < 0) return reply("usage: /maxmsgs <n>");
        updateSchedule(slug, { maxMsgs: n });
        return reply(`per-run cap set to ${n}.`);
      }
      case "snooze": {
        const secs = parseDuration(args);
        if (secs === null) return reply("usage: /snooze <dur> e.g. 2h, 30m, 1d");
        updateSchedule(slug, { snoozeUntil: nowSec() + secs });
        return reply(`😴 snoozed for ${args.trim()} (until ${new Date((nowSec() + secs) * 1000).toISOString()}).`);
      }
      case "when": {
        if (!args.trim()) return reply(`cron: ${sched.cron || "(watch-only)"}`);
        updateSchedule(slug, { cron: args.trim() });
        return reply(`⏰ cadence set to \`${args.trim()}\`.`);
      }
      case "goal": {
        if (!args.trim()) return reply(`goal: ${sched.goal}`);
        updateSchedule(slug, { goal: args.trim() });
        return reply("🎯 goal updated.");
      }
      case "model": {
        if (!args.trim()) return reply(`model: ${sched.model}`);
        try {
          validateModel(args.trim());
        } catch (e) {
          return reply(`❌ ${(e as Error).message}`);
        }
        updateSchedule(slug, { model: args.trim() });
        return reply(`🧠 model set to ${args.trim()}.`);
      }
      case "context":
        return reply("📄 context.md:\n\n" + (getContext(slug) || "(empty)"));
      case "setcontext":
        if (!args.trim()) return reply("usage: /setcontext <full new context.md>");
        setContext(slug, args);
        return reply("💾 context.md replaced — next run will pick it up.");
      case "log":
        return reply("🧾 recent log:\n\n" + (getLogTail(slug) || "(empty)"));
      case "watch": {
        if (!args.trim()) return reply("usage: /watch <criteria>");
        updateSchedule(slug, {
          watch: { watchTarget: { identity: sched.toIdentity, jid: sched.toJid }, criteria: args.trim(), since: nowSec() },
        });
        return reply(`👀 watching for: "${args.trim()}" (on ${sched.toIdentity}).`);
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
        return reply("to delete, use /delete in the General topic (it also closes this topic).");
      default:
        return reply(`unknown command /${command}. /help for the list.`);
    }
  } catch (e) {
    return reply(`❌ ${(e as Error).message}`);
  }
}

/** A free-text message in a topic → resume the schedule's session with it. */
export function handleTopicMessage(sched: Schedule, text: string): RunRequest {
  return { kind: "run", slug: sched.slug, event: "telegram", payload: text, ack: "⏳ …" };
}

export const TOPIC_HELP = [
  "Commands in this schedule's topic:",
  "/status /log /context /setcontext <md>",
  "/pause /resume /dryrun on|off /maxmsgs <n> /snooze <dur>",
  "/when [cron] /goal [text] /model [name]",
  "/watch <criteria> /unwatch /runnow /compact /reset",
  "…or just talk to me — I'll act with this schedule's memory.",
].join("\n");

export const GENERAL_HELP = [
  "wactl scheduled messages — General topic:",
  "/new <phone-or-contact> | <goal>   create a schedule (dryRun by default)",
  "/list                              all schedules",
  "/delete <slug>                     delete a schedule + close its topic",
  "Each schedule gets its own topic; manage it there.",
].join("\n");
