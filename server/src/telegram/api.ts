/**
 * Minimal Telegram Bot API client — raw https, no dependencies (mirrors the
 * style of notify/ntfy.ts). Only the methods wactl-telegram needs: long-poll
 * getUpdates, sendMessage, and the forum-topic lifecycle.
 *
 * Every call posts JSON to https://api.telegram.org/bot<token>/<method> and
 * unwraps the { ok, result, description } envelope.
 */

import https from "https";
import fs from "fs";

export interface ForumTopic {
  message_thread_id: number;
  name: string;
}

export interface PhotoSize {
  file_id: string;
  width: number;
  height: number;
}

export interface TgDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
}

export interface TgUser {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name?: string;
}

export interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  photo?: PhotoSize[];
  document?: TgDocument;
  reply_to_message?: TgMessage;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}

export class TelegramError extends Error {
  constructor(public method: string, public description: string, public code?: number) {
    super(`telegram ${method} failed: ${description}`);
  }
}

export class TelegramClient {
  constructor(private token: string) {}

  private call<T>(method: string, params: Record<string, unknown>, timeoutMs = 15000): Promise<T> {
    const body = JSON.stringify(params);
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: "api.telegram.org",
          path: `/bot${this.token}/${method}`,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: timeoutMs,
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            try {
              const j = JSON.parse(data);
              if (!j.ok) return reject(new TelegramError(method, j.description || "unknown", j.error_code));
              resolve(j.result as T);
            } catch (e) {
              reject(new TelegramError(method, `bad response: ${data.slice(0, 200)}`));
            }
          });
        }
      );
      req.on("timeout", () => req.destroy(new TelegramError(method, "request timed out")));
      req.on("error", (e) => reject(new TelegramError(method, String(e))));
      req.write(body);
      req.end();
    });
  }

  /** Confirm the token is valid and return the bot identity. */
  getMe(): Promise<TgUser> {
    return this.call<TgUser>("getMe", {});
  }

  /**
   * Long-poll for updates. `timeoutSec` is the server-side hold; keep the HTTP
   * timeout a bit longer so we don't kill a healthy long-poll.
   */
  getUpdates(offset: number, timeoutSec = 25): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>(
      "getUpdates",
      { offset, timeout: timeoutSec, allowed_updates: ["message", "edited_message"] },
      (timeoutSec + 10) * 1000
    );
  }

  sendMessage(chatId: number, text: string, threadId?: number, parseMode?: "HTML" | "MarkdownV2"): Promise<TgMessage> {
    const params: Record<string, unknown> = { chat_id: chatId, text, link_preview_options: { is_disabled: true } };
    if (threadId !== undefined) params.message_thread_id = threadId;
    if (parseMode) params.parse_mode = parseMode;
    return this.call<TgMessage>("sendMessage", params);
  }

  /** Show a "typing…" indicator (lasts ~5s; re-send to keep it up). */
  sendChatAction(chatId: number, action: string, threadId?: number): Promise<boolean> {
    const params: Record<string, unknown> = { chat_id: chatId, action };
    if (threadId !== undefined) params.message_thread_id = threadId;
    return this.call<boolean>("sendChatAction", params).catch(() => false);
  }

  /**
   * Register the command menu (autocomplete on "/"). Pass a scope to control
   * WHERE it shows — the default scope only surfaces in private chats, so groups
   * need `all_group_chats` and/or a specific `{type:"chat",chat_id}` scope.
   */
  setMyCommands(
    commands: { command: string; description: string }[],
    scope?: Record<string, unknown>
  ): Promise<boolean> {
    const params: Record<string, unknown> = { commands };
    if (scope) params.scope = scope;
    return this.call<boolean>("setMyCommands", params);
  }

  setMyDescription(description: string): Promise<boolean> {
    return this.call<boolean>("setMyDescription", { description }).catch(() => false);
  }

  setMyShortDescription(short_description: string): Promise<boolean> {
    return this.call<boolean>("setMyShortDescription", { short_description }).catch(() => false);
  }

  createForumTopic(chatId: number, name: string): Promise<ForumTopic> {
    return this.call<ForumTopic>("createForumTopic", { chat_id: chatId, name });
  }

  editForumTopic(chatId: number, threadId: number, name: string): Promise<boolean> {
    return this.call<boolean>("editForumTopic", { chat_id: chatId, message_thread_id: threadId, name });
  }

  closeForumTopic(chatId: number, threadId: number): Promise<boolean> {
    return this.call<boolean>("closeForumTopic", { chat_id: chatId, message_thread_id: threadId });
  }

  /** Resolve a file_id to a downloadable file_path. */
  getFile(fileId: string): Promise<{ file_path: string }> {
    return this.call<{ file_path: string }>("getFile", { file_id: fileId });
  }

  /** Download a Telegram file (by its file_path from getFile) to a local dest. */
  downloadFile(filePath: string, dest: string, timeoutMs = 60000): Promise<void> {
    const url = `https://api.telegram.org/file/bot${this.token}/${filePath}`;
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest, { mode: 0o600 });
      const req = https.get(url, { timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          out.close();
          fs.rmSync(dest, { force: true });
          return reject(new TelegramError("downloadFile", `status ${res.statusCode}`, res.statusCode));
        }
        res.pipe(out);
        out.on("finish", () => out.close(() => resolve()));
      });
      req.on("timeout", () => req.destroy(new TelegramError("downloadFile", "timed out")));
      req.on("error", (e) => {
        out.close();
        fs.rmSync(dest, { force: true });
        reject(new TelegramError("downloadFile", String(e)));
      });
    });
  }
}
