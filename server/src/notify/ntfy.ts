import https from "https";
import http from "http";

interface NotifyConfig {
  method: string; // "ntfy" or "none"
  ntfyTopic?: string;
  ntfyServer?: string; // e.g. "http://localhost:2586" or "https://ntfy.sh"
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

  async notify(event: string, title: string, body: string, priority: string = "urgent"): Promise<void> {
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

    const server = this.config.ntfyServer || "https://ntfy.sh";
    const url = `${server.replace(/\/+$/, "")}/${this.config.ntfyTopic}`;
    const transport = url.startsWith("https") ? https : http;

    return new Promise((resolve) => {
      const req = transport.request(
        url,
        {
          method: "POST",
          headers: {
            Title: title,
            Priority: priority,
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
      "wactl - QR Scan Required",
      `WhatsApp session disconnected (${reason}). Tap to re-authenticate.`
    );
  }

  async notifyUpdateFailed(version: string): Promise<void> {
    await this.notify(
      "update_failed",
      "wactl - Auto-update Failed",
      `Auto-update to ${version} failed. Manual review needed.`
    );
  }

  async notifyQRReady(): Promise<void> {
    await this.notify(
      "qr_ready",
      "wactl - QR Code Ready",
      "WhatsApp needs re-authentication. Tap to scan QR code."
    );
  }

  async notifyConnected(account: string): Promise<void> {
    await this.notify(
      "connected",
      "wactl - Connected",
      `WhatsApp session restored (account: ${account}).`,
      "default"
    );
  }

  async notifyUpdateSuccess(version: string): Promise<void> {
    await this.notify(
      "update_success",
      "wactl - Updated",
      `whatsmeow updated to ${version}. Bridge restarted.`,
      "default"
    );
  }
}
