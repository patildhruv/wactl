/**
 * wactl-telegram — per-instance bot service. Long-polls the Bot API, enforces a
 * fail-closed allowlist, routes updates to schedule handlers, reconciles a forum
 * topic per schedule, and invokes the runner (schedule-run.sh) for messages that
 * need the agent. Its own systemd unit; idles (no crash-loop) when unconfigured.
 *
 * Runs as a separate process from the MCP server, so it reads schedules straight
 * off disk via the store (same DATA_DIR) and shells out to the runner.
 */

import path from "path";
import fs from "fs";
import os from "os";
import { spawn } from "child_process";
import { TelegramClient, TgUpdate } from "./api";
import { AuthzConfig, isAuthorized, parseUserIds, routeUpdate } from "./commands";
import {
  handleTopicCommand,
  handleTopicMessage,
  scheduleForTopic,
  RunRequest,
  GENERAL_HELP,
  BOT_COMMANDS,
  esc,
} from "./handlers";
import { TelegramError } from "./api";
import { listSchedules, getSchedule, createSchedule, deleteSchedule } from "../schedules/store";
import { resolveRecipient } from "../schedules/recipient";
import { BridgeClient } from "../bridge/client";

const INSTANCE = process.env.INSTANCE_NAME || "default";
const DATA_DIR = process.env.DATA_DIR || "./data";
const INSTALL_DIR = process.env.INSTALL_DIR || "/opt/wactl";
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || "4000", 10);
const RUN_SCRIPT = path.join(INSTALL_DIR, "scripts", "schedule-run.sh");

function log(...a: unknown[]) {
  console.log(`[wactl-telegram:${INSTANCE}]`, ...a);
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const groupId = parseInt(process.env.TELEGRAM_GROUP_ID || "", 10);
  const allowedUserIds = parseUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS);

  // Idle (don't crash-loop) when unconfigured — the unit can be enabled ahead of
  // the operator filling in the token.
  if (!token || !Number.isFinite(groupId)) {
    log("TELEGRAM_BOT_TOKEN / TELEGRAM_GROUP_ID not set — idling (feature dormant).");
    // A pending promise alone does NOT keep Node's event loop alive — register a
    // long timer so the process stays up instead of exiting and restart-looping.
    setInterval(() => {}, 1 << 30);
    await new Promise(() => {});
    return;
  }
  if (!allowedUserIds.length) {
    log("WARNING: TELEGRAM_ALLOWED_USER_IDS empty — every message will be denied (fail-closed).");
  }

  const tg = new TelegramClient(token);
  const bridge = new BridgeClient(BRIDGE_PORT);
  const authz: AuthzConfig = { groupId, allowedUserIds };

  const me = await tg.getMe().catch((e) => {
    log("getMe failed — bad token?", String(e));
    process.exit(1);
  });
  log(`connected as @${(me as any).username} — group ${groupId}, ${allowedUserIds.length} allowed user(s)`);

  // Register the slash-command menu (autocomplete on "/") for every scope where
  // we operate — default (private), all group chats, and THIS group specifically
  // (the specific-chat scope is the most reliable for a forum group).
  for (const scope of [undefined, { type: "all_group_chats" }, { type: "chat", chat_id: groupId }]) {
    await tg.setMyCommands(BOT_COMMANDS, scope).catch((e) => log("setMyCommands failed:", String(e)));
  }
  await tg.setMyShortDescription("Schedule context-aware WhatsApp messages — one topic per schedule.").catch(() => {});

  await reconcileTopics(tg, groupId).catch((e) => log("initial topic reconcile failed:", String(e)));

  let offset = 0;
  let lastReconcile = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let updates: TgUpdate[] = [];
    try {
      updates = await tg.getUpdates(offset, 25);
    } catch (e) {
      log("getUpdates error, backing off:", String(e));
      await sleep(3000);
      continue;
    }
    for (const u of updates) {
      offset = Math.max(offset, u.update_id + 1);
      try {
        await handleUpdate(tg, bridge, authz, groupId, u);
      } catch (e) {
        log("handleUpdate error:", String(e));
      }
    }
    // Periodically create topics for any schedule that lacks one (e.g. created
    // from Claude.ai between polls). Cheap: skips when all have topics.
    const now = Date.now();
    if (now - lastReconcile > 30000) {
      lastReconcile = now;
      await reconcileTopics(tg, groupId).catch((e) => log("reconcile:", String(e)));
    }
  }
}

async function handleUpdate(
  tg: TelegramClient,
  bridge: BridgeClient,
  authz: AuthzConfig,
  groupId: number,
  u: TgUpdate
): Promise<void> {
  const msg = u.message;
  if (!msg) return;
  if (!isAuthorized(msg, authz)) return; // fail-closed; silently ignore

  const action = routeUpdate(u);
  switch (action.kind) {
    case "ignore":
      return;
    case "general_command":
      return handleGeneral(tg, bridge, groupId, action.command, action.args, msg.message_thread_id);
    case "topic_command": {
      const sched = scheduleForTopic(action.threadId);
      if (!sched) return void safeSend(tg, groupId, "No schedule is bound to this topic.", action.threadId);
      const res = handleTopicCommand(sched, action.command, action.args);
      return fulfil(tg, groupId, action.threadId, res);
    }
    case "topic_message": {
      const sched = scheduleForTopic(action.threadId);
      if (!sched) return;
      const res = handleTopicMessage(sched, action.text);
      return fulfil(tg, groupId, action.threadId, res);
    }
  }
}

async function handleGeneral(
  tg: TelegramClient,
  bridge: BridgeClient,
  groupId: number,
  command: string,
  args: string,
  threadId?: number
): Promise<void> {
  if (command === "help") return void safeSend(tg, groupId, GENERAL_HELP, threadId);
  if (command === "list") {
    const all = listSchedules();
    const body = all.length
      ? "<b>Schedules</b>\n" + all.map((s) => `• <code>${esc(s.slug)}</code> → ${esc(s.toIdentity)} [${s.enabled ? (s.dryRun ? "dry" : "🔴 live") : "off"}]`).join("\n")
      : "No schedules yet. <code>/new &lt;contact&gt; | &lt;goal&gt;</code>";
    return void safeSend(tg, groupId, body, threadId);
  }
  if (command === "delete") {
    const slug = args.trim();
    if (!slug) return void safeSend(tg, groupId, "usage: <code>/delete &lt;slug&gt;</code> (see /list)", threadId);
    try {
      const s = getSchedule(slug);
      deleteSchedule(slug);
      if (s.telegramTopicId != null) await tg.closeForumTopic(groupId, s.telegramTopicId).catch(() => {});
      await safeSend(tg, groupId, `🗑️ deleted <code>${esc(slug)}</code> (archived to trash; topic closed).`, threadId);
    } catch (e) {
      await safeSend(tg, groupId, `❌ ${esc((e as Error).message)}`, threadId);
    }
    return;
  }
  if (command === "new") {
    // "/new <recipient> | <goal>"  (pipe separates; fallback: first token = recipient)
    const [rawTo, ...rest] = args.includes("|") ? args.split("|") : args.split(/\s+/);
    const to = (rawTo || "").trim();
    const goal = (args.includes("|") ? rest.join("|") : rest.join(" ")).trim();
    if (!to || !goal) return void safeSend(tg, groupId, "usage: <code>/new &lt;phone-or-contact&gt; | &lt;goal&gt;</code>", threadId);
    try {
      const recipient = await resolveRecipient(bridge, to);
      const sched = createSchedule({ to, goal }, recipient);
      await safeSend(tg, groupId, `✅ created <code>${esc(sched.slug)}</code> → ${esc(recipient.identity)} (🧪 dryRun). Creating its topic…`, threadId);
      await reconcileTopics(tg, groupId); // gives it a topic immediately
    } catch (e) {
      await safeSend(tg, groupId, `❌ ${esc((e as Error).message)}`, threadId);
    }
  }
}

/**
 * Send an HTML message, falling back to plain text if Telegram rejects the
 * markup (a missed escape must never mean silence). Bot-authored messages are
 * HTML; freeform agent output is sent plain.
 */
async function safeSend(tg: TelegramClient, chatId: number, text: string, threadId?: number, html = true): Promise<void> {
  try {
    await tg.sendMessage(chatId, text, threadId, html ? "HTML" : undefined);
  } catch (e) {
    if (html && e instanceof TelegramError) {
      log("HTML send rejected, retrying plain:", e.description);
      await tg.sendMessage(chatId, text, threadId).catch((e2) => log("plain send also failed:", String(e2)));
    } else {
      log("send failed:", String(e));
    }
  }
}

/** Post a reply, or run the runner (with a live typing indicator) and post its result. */
async function fulfil(tg: TelegramClient, groupId: number, threadId: number, res: ReturnType<typeof handleTopicCommand>): Promise<void> {
  if (res.kind === "reply") {
    await safeSend(tg, groupId, res.text, threadId);
    return;
  }
  // RunRequest — ack + keep a "typing…" indicator alive while the agent runs.
  await safeSend(tg, groupId, res.ack, threadId);
  tg.sendChatAction(groupId, "typing", threadId);
  const typing = setInterval(() => tg.sendChatAction(groupId, "typing", threadId), 4500);
  let out: string;
  try {
    out = await invokeRunner(res);
  } finally {
    clearInterval(typing);
  }
  // Agent output is freeform (may contain <, >, markdown) → send plain.
  await safeSend(tg, groupId, out || "(no reply)", threadId, false);
}

/** Spawn schedule-run.sh, capture the runner's JSON stdout, return the reply text. */
function invokeRunner(req: RunRequest): Promise<string> {
  return new Promise((resolve) => {
    let payloadFile: string | undefined;
    if (req.payload) {
      payloadFile = path.join(os.tmpdir(), `wactl-tg-${Date.now()}-${Math.floor(process.hrtime()[1])}.txt`);
      fs.writeFileSync(payloadFile, req.payload, { mode: 0o600 });
    }
    const args = [INSTANCE, req.slug, req.event, ...(payloadFile ? [payloadFile] : [])];
    const child = spawn(RUN_SCRIPT, args, { env: process.env });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.on("close", () => {
      if (payloadFile) fs.rmSync(payloadFile, { force: true });
      try {
        const j = JSON.parse(stdout.trim().split("\n").pop() || "{}");
        resolve(j.reply || j.result || "(done)");
      } catch {
        resolve("(done)");
      }
    });
    child.on("error", (e) => resolve(`run failed: ${e.message}`));
  });
}

/** Create a forum topic for any schedule missing one; write the id back. */
async function reconcileTopics(tg: TelegramClient, groupId: number): Promise<void> {
  for (const s of listSchedules()) {
    if (s.telegramTopicId != null) continue;
    try {
      const topic = await tg.createForumTopic(groupId, s.slug);
      const { updateSchedule } = await import("../schedules/store");
      updateSchedule(s.slug, { telegramTopicId: topic.message_thread_id });
      await safeSend(
        tg,
        groupId,
        `🆕 <b>${esc(s.slug)}</b> → ${esc(s.toIdentity)} (🧪 dryRun)\nManage it here — <code>/status</code>, <code>/help</code>, or just talk to me.`,
        topic.message_thread_id
      );
      log(`created topic ${topic.message_thread_id} for ${s.slug}`);
    } catch (e) {
      log(`topic create failed for ${s.slug}:`, String(e));
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  log("fatal:", String(e));
  process.exit(1);
});
