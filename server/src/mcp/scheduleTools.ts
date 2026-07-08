import { z } from "zod";
import type { BridgeClient } from "../bridge/client";
import type { ToolDef } from "./toolDefinitions";
import {
  createSchedule,
  listSchedules,
  getSchedule,
  getContext,
  getLogTail,
  updateSchedule,
  deleteSchedule,
  requestRunNow,
  authorizeSend,
  appendLog,
  validateModel,
  ResolvedRecipient,
} from "../schedules/store";

/**
 * Scheduled-messages MCP tools (spec docs/scheduled-messages-spec.md §5, §13).
 *
 * These are spread into TOOLS[] in toolDefinitions.ts, so they register on every
 * transport exactly like the WhatsApp tools. They read process.env.DATA_DIR (the
 * download_media precedent) and use `bridge` only for recipient resolution
 * (create) and the actual send (schedule_send).
 *
 * The load-bearing security property lives in `schedule_send`: the recipient is
 * ALWAYS the schedule's pinned JID and every send is authorized server-side
 * against a per-run token + per-run/per-day caps — none of which the LLM can
 * override (spec §13.1).
 */

/** Resolve a phone / JID / contact-name into a canonical identity + JID. */
async function resolveRecipient(
  bridge: BridgeClient,
  to: string
): Promise<ResolvedRecipient> {
  const looksAddressable = to.includes("@") || /^[0-9+\s-]+$/.test(to);
  if (looksAddressable) {
    try {
      const m = await bridge.resolveJid(to.replace(/[\s-]/g, ""));
      return { identity: m.phone || m.user, jid: m.jid };
    } catch {
      // fall through to contact search
    }
  }
  const contacts = await bridge.getContacts(to);
  if (contacts.length > 0) {
    const c = contacts[0];
    return { identity: c.number || c.id.split("@")[0], jid: c.id };
  }
  throw new Error(
    `could not resolve recipient '${to}' — pass a phone number, a full JID, or a saved contact name`
  );
}

function summarize(s: ReturnType<typeof getSchedule>) {
  return {
    slug: s.slug,
    goal: s.goal,
    enabled: s.enabled,
    dryRun: s.dryRun,
    cron: s.cron,
    to: s.toIdentity,
    model: s.model,
    maxMsgs: s.maxMsgs,
    perDayMax: s.perDayMax,
    watch: s.watch ? s.watch.criteria : null,
    telegramTopicId: s.telegramTopicId,
    lastRun: s.lastRun,
  };
}

export const SCHEDULE_TOOLS: ToolDef<any>[] = [
  {
    name: "schedule_create",
    description: `Create a scheduled-message schedule: repeating, context-aware WhatsApp outreach with its own durable memory.

The new schedule is created **dryRun=true** — it will NOT send anything until you explicitly disable dryRun (schedule_update or /dryrun off). It reserves a Claude session and seeds a context.md memory doc from \`goal\`, but spends nothing until first triggered. A Telegram topic is provisioned separately by the bot.

Parameters:
  to (string, required): recipient — a phone ("919999900000"), a full JID, or a saved contact name. Resolved + pinned now; every future send goes only here.
  goal (string, required): what this schedule should achieve (e.g. "Nudge landlord for the rent receipt on the 1st, politely"). Also seeds context.md.
  cron (string, optional): 5-field cron for the cadence (e.g. "0 9 * * 1"). Omit for a watch-only schedule.
  model (string, optional): per-schedule model; must be a >=1M-context model from the allowlist.
  checkMessages (boolean, optional, default true): pull recent messages before drafting.
  maxMsgs (number, optional, default 1): per-run send cap (server-enforced).
  perDayMax (number, optional, default 3): per-day send ceiling (server-enforced).
  dryRun (boolean, optional, default true): keep true to test safely.

Returns: the created schedule (slug is its handle for other schedule_* tools).`,
    schema: {
      to: z.string().describe("Recipient: phone, full JID, or saved contact name"),
      goal: z.string().describe("What this schedule should achieve; seeds context.md"),
      cron: z.string().optional().describe("5-field cron cadence; omit for watch-only"),
      model: z.string().optional().describe(">=1M-context model id from the allowlist"),
      checkMessages: z.boolean().optional().describe("Pull recent messages before drafting (default true)"),
      maxMsgs: z.number().optional().describe("Per-run send cap (default 1)"),
      perDayMax: z.number().optional().describe("Per-day send ceiling (default 3)"),
      dryRun: z.boolean().optional().describe("Keep true to test without sending (default true)"),
    },
    handler: async (
      bridge,
      args: {
        to: string;
        goal: string;
        cron?: string;
        model?: string;
        checkMessages?: boolean;
        maxMsgs?: number;
        perDayMax?: number;
        dryRun?: boolean;
      }
    ) => {
      if (args.model) validateModel(args.model);
      const recipient = await resolveRecipient(bridge, args.to);
      const schedule = createSchedule(
        {
          to: args.to,
          goal: args.goal,
          cron: args.cron ?? null,
          model: args.model,
          checkMessages: args.checkMessages,
          maxMsgs: args.maxMsgs,
          perDayMax: args.perDayMax,
          dryRun: args.dryRun,
        },
        recipient
      );
      return schedule;
    },
  },

  {
    name: "schedule_list",
    description: `List all schedules with their status (enabled, dryRun, cadence, recipient, model, caps).

Parameters: none.
Returns: [{ slug, goal, enabled, dryRun, cron, to, model, maxMsgs, perDayMax, watch, telegramTopicId, lastRun }]`,
    schema: {},
    handler: async () => listSchedules().map(summarize),
  },

  {
    name: "schedule_get",
    description: `Get one schedule in full, including its context.md memory and the tail of its run log.

Parameters:
  slug (string, required): the schedule handle from schedule_create / schedule_list.
Returns: { schedule, context (context.md text), logTail }`,
    schema: {
      slug: z.string().describe("Schedule handle (slug)"),
    },
    handler: async (_bridge, args: { slug: string }) => ({
      schedule: getSchedule(args.slug),
      context: getContext(args.slug),
      logTail: getLogTail(args.slug),
    }),
  },

  {
    name: "schedule_update",
    description: `Patch a schedule's fields. Use this to arm/disarm sending and tune behavior.

Common uses:
  enabled=false  → kill switch (skip all runs)
  dryRun=false   → START actually sending (was created dry)
  snoozeUntil=<unix seconds> → suppress runs until a time
  cron, goal, maxMsgs, perDayMax, checkMessages, model → tune

Parameters:
  slug (string, required).
  Any of: enabled, dryRun, cron, goal, maxMsgs, perDayMax, checkMessages, snoozeUntil, model.
Returns: the updated schedule.

Note: the pinned recipient is NOT patchable here (it is re-resolved through a dedicated path); model must be a >=1M-context allowlisted id.`,
    schema: {
      slug: z.string().describe("Schedule handle (slug)"),
      enabled: z.boolean().optional().describe("Kill switch"),
      dryRun: z.boolean().optional().describe("false = start sending"),
      cron: z.string().optional().describe("5-field cron cadence"),
      goal: z.string().optional().describe("Updated objective"),
      maxMsgs: z.number().optional().describe("Per-run send cap"),
      perDayMax: z.number().optional().describe("Per-day send ceiling"),
      checkMessages: z.boolean().optional().describe("Pull recent messages before drafting"),
      snoozeUntil: z.number().optional().describe("Unix seconds to suppress runs until"),
      model: z.string().optional().describe(">=1M-context model id"),
    },
    handler: async (
      _bridge,
      args: {
        slug: string;
        enabled?: boolean;
        dryRun?: boolean;
        cron?: string;
        goal?: string;
        maxMsgs?: number;
        perDayMax?: number;
        checkMessages?: boolean;
        snoozeUntil?: number;
        model?: string;
      }
    ) => {
      const { slug, ...patch } = args;
      return updateSchedule(slug, patch);
    },
  },

  {
    name: "schedule_delete",
    description: `Delete a schedule. The folder is moved to a trash area (auditable), not hard-deleted; the Telegram topic is closed separately by the bot.

Parameters:
  slug (string, required).
Returns: { archivedTo }`,
    schema: {
      slug: z.string().describe("Schedule handle (slug)"),
    },
    handler: async (_bridge, args: { slug: string }) => deleteSchedule(args.slug),
  },

  {
    name: "schedule_run_now",
    description: `Trigger a schedule to run on the next cron tick (drops a .trigger file — does not execute inline).

Parameters:
  slug (string, required).
Returns: { ok: true }`,
    schema: {
      slug: z.string().describe("Schedule handle (slug)"),
    },
    handler: async (_bridge, args: { slug: string }) => {
      requestRunNow(args.slug);
      return { ok: true };
    },
  },

  {
    name: "schedule_send",
    description: `Send a message for a schedule. INTERNAL — this is the only send path a scheduled agent is given, and only during a live run.

You do NOT choose the recipient: the message always goes to the schedule's pinned target. The send is authorized server-side against a per-run token and the schedule's per-run (maxMsgs) and per-day (perDayMax) caps; it is rejected if the schedule is disabled, in dryRun, snoozed, the token is missing/expired, or a cap is hit.

Parameters:
  slug (string, required): the schedule this run belongs to.
  token (string, required): the per-run send token issued to this run.
  body (string, required): the message text.
Returns: { messageId, timestamp, to } — \`to\` is the pinned recipient the server chose.`,
    schema: {
      slug: z.string().describe("Schedule handle (slug)"),
      token: z.string().describe("Per-run send token issued to this run"),
      body: z.string().describe("Message text"),
    },
    handler: async (bridge, args: { slug: string; token: string; body: string }) => {
      const { toJid } = authorizeSend(args.slug, args.token);
      const res = await bridge.sendMessage(toJid, args.body);
      appendLog(args.slug, `sent messageId=${res.messageId} to=${toJid}`);
      return { messageId: res.messageId, timestamp: res.timestamp, to: toJid };
    },
  },
];
