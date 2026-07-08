/**
 * Pure Telegram routing logic — no network, no fs — so it's exhaustively
 * unit-testable. Three concerns: authorization (fail-closed), command parsing,
 * and routing an update to an action.
 */

import { TgUpdate, TgMessage } from "./api";

export interface AuthzConfig {
  groupId: number; // TELEGRAM_GROUP_ID
  allowedUserIds: number[]; // TELEGRAM_ALLOWED_USER_IDS (empty = deny all)
}

/**
 * Fail-closed per-message authorization (spec §13.4). BOTH must hold:
 *  - the message is in the configured group, AND
 *  - the sender is in the allowlist.
 * An empty allowlist denies everyone.
 */
export function isAuthorized(msg: TgMessage, cfg: AuthzConfig): boolean {
  if (!cfg.allowedUserIds.length) return false; // empty allowlist = deny all
  if (!msg.from || msg.from.is_bot) return false;
  if (msg.chat.id !== cfg.groupId) return false;
  return cfg.allowedUserIds.includes(msg.from.id);
}

/** Parse "TELEGRAM_ALLOWED_USER_IDS" style CSV into numbers (bad entries dropped). */
export function parseUserIds(csv: string | undefined): number[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

export interface ParsedCommand {
  command: string; // without leading slash, lowercased, @botname stripped
  args: string; // everything after the command, trimmed
}

/** Parse a leading slash command. Returns null if the text isn't a command. */
export function parseCommand(text: string | undefined): ParsedCommand | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const sp = trimmed.indexOf(" ");
  const head = sp === -1 ? trimmed : trimmed.slice(0, sp);
  const args = sp === -1 ? "" : trimmed.slice(sp + 1).trim();
  const command = head.slice(1).split("@")[0].toLowerCase(); // /pause@wactlbot → pause
  return { command, args };
}

/** Commands valid only in the General topic (no thread id) — schedule lifecycle. */
export const GENERAL_COMMANDS = new Set(["new", "list", "help", "delete"]);

export type Action =
  | { kind: "ignore"; reason: string }
  | { kind: "general_command"; command: string; args: string; msg: TgMessage }
  | { kind: "topic_command"; command: string; args: string; threadId: number; msg: TgMessage }
  | { kind: "topic_message"; text: string; threadId: number; msg: TgMessage };

/**
 * Decide what an update means. Assumes authorization already passed. The General
 * topic has no message_thread_id (or thread id 1); real schedule topics have one.
 */
export function routeUpdate(update: TgUpdate): Action {
  const msg = update.message;
  if (!msg) return { kind: "ignore", reason: "no message" };

  // General-topic messages either have no thread id or the reserved id 1.
  const threadId = msg.is_topic_message ? msg.message_thread_id : undefined;
  const parsed = parseCommand(msg.text);

  if (threadId === undefined || threadId === 1) {
    if (parsed && GENERAL_COMMANDS.has(parsed.command)) {
      return { kind: "general_command", command: parsed.command, args: parsed.args, msg };
    }
    return { kind: "ignore", reason: "non-lifecycle message in General topic" };
  }

  if (parsed) {
    return { kind: "topic_command", command: parsed.command, args: parsed.args, threadId, msg };
  }
  // Actionable if it has text OR a media attachment (photo/document); the caption
  // rides along as the text.
  const hasMedia = !!(msg.photo?.length || msg.document);
  if (msg.text || hasMedia) {
    return { kind: "topic_message", text: msg.text || msg.caption || "", threadId, msg };
  }
  return { kind: "ignore", reason: "empty topic message" };
}
