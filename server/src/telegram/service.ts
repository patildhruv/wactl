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
  mdToTelegramHtml,
  formatRunnerOutcome,
  orphanedTopicIds,
} from "./handlers";
import { TelegramError } from "./api";
import {
  listSchedules,
  getSchedule,
  createSchedule,
  deleteSchedule,
  ensureOrchestrator,
  listTrashedTopics,
  markTopicClosed,
  ORCHESTRATOR_SLUG,
  TrashedTopic,
} from "../schedules/store";
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
    case "orchestrator_message": {
      // Free text / attachment in General → the persistent orchestrator session.
      const sched = ensureOrchestrator();
      const att = await gatherAttachments(tg, msg);
      let text = action.text;
      if (att.paths.length) {
        text =
          `[The user attached ${att.paths.length} file(s). Read each path below to view its contents ` +
          `(you can Read images and PDFs):]\n${att.paths.join("\n")}` +
          (text ? `\n\nTheir message: ${text}` : "");
      }
      const res = handleTopicMessage(sched, text || "(no text)");
      try {
        await fulfil(tg, groupId, msg.message_thread_id, res);
      } finally {
        if (att.dir) fs.rmSync(att.dir, { recursive: true, force: true });
      }
      return;
    }
    case "topic_command": {
      const sched = scheduleForTopic(action.threadId);
      if (!sched) return void safeSend(tg, groupId, "No schedule is bound to this topic.", action.threadId);
      const res = handleTopicCommand(sched, action.command, action.args);
      return fulfil(tg, groupId, action.threadId, res);
    }
    case "topic_message": {
      const sched = scheduleForTopic(action.threadId);
      if (!sched) return;
      const att = await gatherAttachments(tg, msg);
      let text = action.text;
      if (att.paths.length) {
        text =
          `[The user attached ${att.paths.length} file(s). Read each path below to view its contents ` +
          `(you can Read images and PDFs):]\n${att.paths.join("\n")}` +
          (text ? `\n\nTheir message: ${text}` : "");
      }
      const res = handleTopicMessage(sched, text || "(no text)");
      try {
        await fulfil(tg, groupId, action.threadId, res);
      } finally {
        if (att.dir) fs.rmSync(att.dir, { recursive: true, force: true });
      }
      return;
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

/** Post a reply, or run the runner (with a live typing indicator) and post its result.
 *  threadId is undefined for the General topic (orchestrator). */
async function fulfil(tg: TelegramClient, groupId: number, threadId: number | undefined, res: ReturnType<typeof handleTopicCommand>): Promise<void> {
  if (res.kind === "reply") {
    await safeSend(tg, groupId, res.text, threadId);
    return;
  }
  // RunRequest — no textual ack (the live "typing…" indicator already signals
  // work is happening). Keep the indicator alive until the agent replies.
  tg.sendChatAction(groupId, "typing", threadId);
  const typing = setInterval(() => tg.sendChatAction(groupId, "typing", threadId), 4500);
  let out: string;
  try {
    out = await invokeRunner(res);
  } finally {
    clearInterval(typing);
  }
  await sendAgentText(tg, groupId, threadId, out || "(no reply)");
}

/**
 * Send freeform agent output: render its Markdown into Telegram HTML so `**bold**`
 * and backtick-code don't show as raw markers. Falls back to the RAW text (not the
 * half-built HTML) if Telegram rejects the markup — never tag soup, never silence.
 */
async function sendAgentText(tg: TelegramClient, chatId: number, threadId: number | undefined, text: string): Promise<void> {
  try {
    await tg.sendMessage(chatId, mdToTelegramHtml(text), threadId, "HTML");
  } catch (e) {
    if (e instanceof TelegramError) {
      log("agent HTML send rejected, retrying plain:", e.description);
      await tg.sendMessage(chatId, text, threadId).catch((e2) => log("plain send also failed:", String(e2)));
    } else {
      log("agent send failed:", String(e));
    }
  }
}

/**
 * Download any photo/document on a Telegram message into a temp dir the (wactl)
 * runner can Read. Returns local file paths + the dir (caller removes it after
 * the run). Best-effort — a failed download is logged and skipped.
 */
async function gatherAttachments(
  tg: TelegramClient,
  msg: { photo?: { file_id: string }[]; document?: { file_id: string; file_name?: string } } | undefined
): Promise<{ paths: string[]; dir: string | null }> {
  if (!msg) return { paths: [], dir: null };
  const specs: { file_id: string; name: string }[] = [];
  if (msg.document) specs.push({ file_id: msg.document.file_id, name: msg.document.file_name || "document" });
  if (msg.photo?.length) specs.push({ file_id: msg.photo[msg.photo.length - 1].file_id, name: "photo.jpg" });
  if (!specs.length) return { paths: [], dir: null };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wactl-tg-att-"));
  const paths: string[] = [];
  for (const s of specs) {
    try {
      const f = await tg.getFile(s.file_id);
      const safe = (s.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80)) || "file";
      const dest = path.join(dir, safe);
      await tg.downloadFile(f.file_path, dest);
      paths.push(dest);
    } catch (e) {
      log("attachment download failed:", String(e));
    }
  }
  return { paths, dir };
}

/**
 * Spawn schedule-run.sh and turn the finished process into operator-facing text.
 *
 * Both streams AND the exit code are captured: a failing run must never be
 * silently rendered as "(done)" again (see formatRunnerOutcome). The verdict
 * itself is computed by that pure function so it can be unit-tested; this
 * function stays the impure shell that spawns, cleans up, and logs.
 */
function invokeRunner(req: RunRequest): Promise<string> {
  return new Promise((resolve) => {
    let payloadFile: string | undefined;
    if (req.payload) {
      payloadFile = path.join(os.tmpdir(), `wactl-tg-${Date.now()}-${Math.floor(process.hrtime()[1])}.txt`);
      fs.writeFileSync(payloadFile, req.payload, { mode: 0o600 });
    }
    const cleanup = () => {
      if (payloadFile) fs.rmSync(payloadFile, { force: true });
      payloadFile = undefined; // spawn errors can fire 'error' without 'close'
    };
    const args = [INSTANCE, req.slug, req.event, ...(payloadFile ? [payloadFile] : [])];
    const child = spawn(RUN_SCRIPT, args, { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      cleanup();
      const { text, failure } = formatRunnerOutcome({ code, stdout, stderr });
      if (failure) log(`runner FAILED ${req.slug} (${req.event}): ${failure}`);
      resolve(text);
    });
    child.on("error", (e) => {
      cleanup();
      log(`runner SPAWN FAILED ${req.slug} (${req.event}): ${String(e)}`);
      resolve(`⚠️ run failed to start: ${e.message}`);
    });
  });
}

/** Create a topic for any schedule missing one, and close topics left by deleted schedules. */
async function reconcileTopics(tg: TelegramClient, groupId: number): Promise<void> {
  await createMissingTopics(tg, groupId);
  await reapOrphanTopics(tg, groupId);
}

/**
 * Close topics whose schedule no longer exists.
 *
 * Only the /delete command closes a topic (handleGeneral); the schedule_delete
 * MCP tool just archives the folder — despite its own description claiming the
 * bot closes the topic. So every MCP deletion left its topic open forever, and
 * nothing swept them. Reaping here, in the process that owns the Telegram
 * client, covers EVERY deletion path (including a crash between delete and
 * close, or a folder moved by hand) rather than patching only the one that
 * leaked. Idempotent: a marker in the trash folder stops re-processing.
 */
async function reapOrphanTopics(tg: TelegramClient, groupId: number): Promise<void> {
  let trashed: TrashedTopic[] = [];
  try {
    trashed = listTrashedTopics();
  } catch (e) {
    log("orphan sweep: trash scan failed:", String(e));
    return;
  }
  if (!trashed.length) return;

  const liveIds: (number | null)[] = listSchedules().map((s) => s.telegramTopicId);
  try {
    // listSchedules() filters the orchestrator out, so add its topic back by hand.
    liveIds.push(getSchedule(ORCHESTRATOR_SLUG).telegramTopicId);
  } catch {
    // Orchestrator not seeded yet — the id <= 1 guard still protects General.
  }

  const closable = new Set(orphanedTopicIds(liveIds, trashed));
  if (!closable.size) return;

  for (const t of trashed) {
    if (!closable.has(t.telegramTopicId)) continue;
    try {
      await tg.closeForumTopic(groupId, t.telegramTopicId);
      markTopicClosed(t.dir);
      log(`orphan sweep: closed topic ${t.telegramTopicId} (deleted schedule ${t.slug})`);
    } catch (e) {
      // An error_code means Telegram received the request and refused it (already
      // closed, or the topic is gone) — retrying can't help, so mark it done. A
      // transport failure carries no code: leave it for the next sweep.
      if (e instanceof TelegramError && typeof e.code === "number") {
        markTopicClosed(t.dir);
        log(`orphan sweep: topic ${t.telegramTopicId} (${t.slug}) refused: ${e.description} — marking done`);
      } else {
        log(`orphan sweep: topic ${t.telegramTopicId} (${t.slug}) failed, will retry: ${String(e)}`);
      }
    }
  }
}

/** Create a forum topic for any schedule missing one; write the id back. */
async function createMissingTopics(tg: TelegramClient, groupId: number): Promise<void> {
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
