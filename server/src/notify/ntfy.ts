import https from "https";

interface NotifyConfig {
  method: string; // "ntfy" or "none"
  ntfyTopic?: string;
  serverIP?: string;
  serverHostname?: string;
  basePath?: string;
  adminPort: number;
}

const DEBOUNCE_MS = 10 * 60 * 1000; // 10 minutes
const lastNotified = new Map<string, number>();

export class Notifier {
  private config: NotifyConfig;

  constructor(config: NotifyConfig) {
    this.config = config;
  }

  async notify(event: string, title: string, body: string): Promise<void> {
    if (this.config.method !== "ntfy" || !this.config.ntfyTopic) {
      return;
    }

    // Debounce: don't send more than 1 notification per 10 minutes per event type
    const now = Date.now();
    const lastTime = lastNotified.get(event);
    if (lastTime && now - lastTime < DEBOUNCE_MS) {
      return;
    }
    lastNotified.set(event, now);

    // Build click URL: prefer HTTPS hostname (with optional base path for multi-instance),
    // fall back to direct IP + port for standalone installs
    let clickURL = "";
    if (this.config.serverHostname) {
      const bp = this.config.basePath || "";
      clickURL = `https://${this.config.serverHostname}${bp}/auth`;
    } else if (this.config.serverIP) {
      clickURL = `http://${this.config.serverIP}:${this.config.adminPort}/auth`;
    }

    const url = `https://ntfy.sh/${this.config.ntfyTopic}`;

    return new Promise((resolve) => {
      const req = https.request(
        url,
        {
          method: "POST",
          headers: {
            Title: title,
            Priority: "urgent",
            ...(clickURL ? { Click: clickURL } : {}),
          },
        },
        (res) => {
          res.resume();
          resolve();
        }
      );
      req.on("error", () => resolve());
      req.write(body);
      req.end();
    });
  }

  async notifyDisconnect(reason: string): Promise<void> {
    await this.notify(
      "disconnect",
      "wactl — QR Scan Required",
      `WhatsApp session disconnected (${reason}). Tap to re-authenticate.`
    );
  }

  async notifyUpdateFailed(version: string): Promise<void> {
    await this.notify(
      "update_failed",
      "wactl — Auto-update Failed",
      `Auto-update to ${version} failed. Manual review needed.`
    );
  }
}
