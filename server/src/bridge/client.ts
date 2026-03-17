import http from "http";
import https from "https";
import { URL } from "url";
import fs from "fs";
import path from "path";

export interface BridgeStatus {
  connected: boolean;
  loggedIn: boolean;
  uptime: number;
  account: string;
}

export interface QRResponse {
  qr: string | null;
  expiresAt: number | null;
}

export interface ChatSummary {
  id: string;
  name: string;
  lastMessage: string;
  timestamp: number;
  unread: number;
}

export interface MessageRecord {
  id: string;
  from: string;
  body: string;
  timestamp: number;
  isFromMe: boolean;
  hasMedia: boolean;
  mediaType?: string;
}

export interface ContactRecord {
  id: string;
  name: string;
  number: string;
  isGroup: boolean;
}

export interface SendResult {
  messageId: string;
  timestamp: number;
}

export class BridgeClient {
  private baseURL: string;

  constructor(bridgePort: number = 4000) {
    this.baseURL = `http://127.0.0.1:${bridgePort}`;
  }

  async getStatus(): Promise<BridgeStatus> {
    return this.get<BridgeStatus>("/status");
  }

  async getQR(): Promise<QRResponse> {
    return this.get<QRResponse>("/qr");
  }

  async getChats(): Promise<ChatSummary[]> {
    return this.get<ChatSummary[]>("/chats");
  }

  async getChatMessages(
    chatId: string,
    limit: number = 50,
    before?: number
  ): Promise<MessageRecord[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set("before", String(before));
    return this.get<MessageRecord[]>(
      `/chats/${encodeURIComponent(chatId)}/messages?${params}`
    );
  }

  async getContacts(query?: string): Promise<ContactRecord[]> {
    const params = query ? `?q=${encodeURIComponent(query)}` : "";
    return this.get<ContactRecord[]>(`/contacts${params}`);
  }

  async sendMessage(to: string, body: string): Promise<SendResult> {
    return this.post<SendResult>("/send", { to, body });
  }

  async sendFile(
    to: string,
    filePath: string,
    caption?: string
  ): Promise<SendResult> {
    const boundary = `----wactl${Date.now()}`;
    const fileName = path.basename(filePath);
    const fileData = fs.readFileSync(filePath);

    let body = "";
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="to"\r\n\r\n${to}\r\n`;
    if (caption) {
      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`;
    }
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`;
    body += `Content-Type: application/octet-stream\r\n\r\n`;

    const prefix = Buffer.from(body, "utf-8");
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8");
    const payload = Buffer.concat([prefix, fileData, suffix]);

    return this.rawPost<SendResult>("/send-file", payload, {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    });
  }

  async downloadMedia(messageId: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseURL}/media/${encodeURIComponent(messageId)}`);
      http
        .get(url, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`Media download failed: ${res.statusCode}`));
            res.resume();
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        })
        .on("error", reject);
    });
  }

  async logout(): Promise<{ ok: boolean }> {
    return this.post<{ ok: boolean }>("/logout", {});
  }

  private get<T>(path: string): Promise<T> {
    return new Promise((resolve, reject) => {
      http
        .get(`${this.baseURL}${path}`, (res) => {
          let data = "";
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => {
            try {
              if (res.statusCode && res.statusCode >= 400) {
                reject(new Error(`Bridge error ${res.statusCode}: ${data}`));
                return;
              }
              resolve(JSON.parse(data) as T);
            } catch (e) {
              reject(new Error(`Invalid JSON: ${data}`));
            }
          });
          res.on("error", reject);
        })
        .on("error", reject);
    });
  }

  private post<T>(path: string, body: object): Promise<T> {
    const payload = JSON.stringify(body);
    return this.rawPost<T>(path, Buffer.from(payload), {
      "Content-Type": "application/json",
    });
  }

  private rawPost<T>(
    path: string,
    payload: Buffer,
    headers: Record<string, string>
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.baseURL}${path}`);
      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: {
            ...headers,
            "Content-Length": String(payload.length),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => {
            try {
              if (res.statusCode && res.statusCode >= 400) {
                reject(new Error(`Bridge error ${res.statusCode}: ${data}`));
                return;
              }
              resolve(JSON.parse(data) as T);
            } catch (e) {
              reject(new Error(`Invalid JSON: ${data}`));
            }
          });
          res.on("error", reject);
        }
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }
}
