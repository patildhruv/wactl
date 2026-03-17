import https from "https";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { Notifier } from "../notify/ntfy";

interface UpdateRecord {
  timestamp: string;
  currentVersion: string;
  latestVersion: string;
  action: string;
  result: string;
}

export class AutoUpdater {
  private dataDir: string;
  private bridgeDir: string;
  private notifier: Notifier;
  private cronInterval: NodeJS.Timeout | null = null;

  constructor(dataDir: string, bridgeDir: string, notifier: Notifier) {
    this.dataDir = dataDir;
    this.bridgeDir = bridgeDir;
    this.notifier = notifier;
  }

  start(cronExpr: string): void {
    // Simple daily check — parse hour from cron (default: 3 AM)
    // For simplicity, run every 24 hours from startup
    const intervalMs = 24 * 60 * 60 * 1000;
    this.cronInterval = setInterval(() => this.checkForUpdate(), intervalMs);
    console.log("[updater] Auto-update scheduled (every 24h)");
  }

  stop(): void {
    if (this.cronInterval) {
      clearInterval(this.cronInterval);
      this.cronInterval = null;
    }
  }

  async checkForUpdate(): Promise<void> {
    console.log("[updater] Checking for whatsmeow updates...");

    try {
      const currentVersion = this.getCurrentVersion();
      const latestVersion = await this.getLatestVersion();

      if (!latestVersion) {
        this.recordUpdate(currentVersion, "unknown", "check", "failed to fetch latest version");
        return;
      }

      if (currentVersion === latestVersion) {
        console.log(`[updater] Already on latest: ${currentVersion}`);
        this.recordUpdate(currentVersion, latestVersion, "no_update", "up to date");
        return;
      }

      console.log(`[updater] Update available: ${currentVersion} → ${latestVersion}`);

      // Attempt update
      try {
        execSync("go get go.mau.fi/whatsmeow@latest", {
          cwd: this.bridgeDir,
          env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/go/bin` },
          timeout: 120000,
        });

        execSync("go build -o wactl-bridge-new .", {
          cwd: this.bridgeDir,
          env: { ...process.env, PATH: `${process.env.PATH}:/usr/local/go/bin`, CGO_ENABLED: "1" },
          timeout: 120000,
        });

        // Self-test: try to start the new binary and check /status
        const testPort = 4099;
        const newBinary = path.join(this.bridgeDir, "wactl-bridge-new");

        let testPassed = false;
        try {
          const child = require("child_process").spawn(newBinary, [], {
            env: { ...process.env, BRIDGE_PORT: String(testPort), DATA_DIR: path.join(this.dataDir, "test") },
            stdio: "ignore",
            detached: true,
          });

          // Give it 5 seconds to start
          await new Promise((r) => setTimeout(r, 5000));

          try {
            const res = await this.httpGet(`http://127.0.0.1:${testPort}/status`);
            testPassed = res.includes("connected");
          } catch {
            // Test endpoint not responding
          }

          try {
            process.kill(-child.pid!, "SIGTERM");
          } catch {
            // Process may have already exited
          }
        } catch {
          // Spawn failed
        }

        if (testPassed) {
          // Replace old binary
          const oldBinary = path.join(this.bridgeDir, "wactl-bridge");
          fs.copyFileSync(newBinary, oldBinary);
          fs.unlinkSync(newBinary);
          console.log(`[updater] Updated to ${latestVersion}`);
          this.recordUpdate(currentVersion, latestVersion, "updated", "success");
        } else {
          // Rollback
          try { fs.unlinkSync(path.join(this.bridgeDir, "wactl-bridge-new")); } catch {}
          console.log(`[updater] Self-test failed, rolling back`);
          this.recordUpdate(currentVersion, latestVersion, "updated", "self-test failed, rolled back");
          await this.notifier.notifyUpdateFailed(latestVersion);
        }
      } catch (buildErr) {
        try { fs.unlinkSync(path.join(this.bridgeDir, "wactl-bridge-new")); } catch {}
        console.error("[updater] Build failed:", buildErr);
        this.recordUpdate(currentVersion, latestVersion, "updated", "build failed");
        await this.notifier.notifyUpdateFailed(latestVersion);
      }
    } catch (err) {
      console.error("[updater] Check failed:", err);
    }
  }

  private getCurrentVersion(): string {
    try {
      const goMod = fs.readFileSync(path.join(this.bridgeDir, "go.mod"), "utf-8");
      const match = goMod.match(/go\.mau\.fi\/whatsmeow\s+(v[\S]+)/);
      return match ? match[1] : "unknown";
    } catch {
      return "unknown";
    }
  }

  private getLatestVersion(): Promise<string | null> {
    return new Promise((resolve) => {
      https
        .get(
          "https://api.github.com/repos/tulir/whatsmeow/tags?per_page=1",
          { headers: { "User-Agent": "wactl-updater" } },
          (res) => {
            let data = "";
            res.on("data", (chunk: string) => (data += chunk));
            res.on("end", () => {
              try {
                const tags = JSON.parse(data);
                resolve(tags[0]?.name || null);
              } catch {
                resolve(null);
              }
            });
          }
        )
        .on("error", () => resolve(null));
    });
  }

  private recordUpdate(current: string, latest: string, action: string, result: string): void {
    const historyPath = path.join(this.dataDir, "update-history.json");
    let history: UpdateRecord[] = [];
    try {
      history = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
    } catch {}

    history.unshift({
      timestamp: new Date().toISOString(),
      currentVersion: current,
      latestVersion: latest,
      action,
      result,
    });

    // Keep last 20 entries
    history = history.slice(0, 20);
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  }

  private httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith("https") ? https : require("http");
      mod.get(url, (res: any) => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => resolve(data));
        res.on("error", reject);
      }).on("error", reject);
    });
  }
}
