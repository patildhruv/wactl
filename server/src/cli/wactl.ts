#!/usr/bin/env node

import { Command } from "commander";
import http from "http";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";

// chalk@4 and boxen@5 are CommonJS-compatible
const chalk = require("chalk");
const boxen = require("boxen");

const ADMIN_PORT = process.env.ADMIN_PORT || "8080";
const BASE_URL = `http://127.0.0.1:${ADMIN_PORT}`;

function fetchJSON(urlPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    http
      .get(`${BASE_URL}${urlPath}`, (res) => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid response from server: ${data.substring(0, 100)}`));
          }
        });
        res.on("error", reject);
      })
      .on("error", (err) => {
        reject(new Error(`Cannot connect to wactl server: ${err.message}`));
      });
  });
}

function formatUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.substring(0, 4) + "****" + key.substring(key.length - 4);
}

const program = new Command();
program.name("wactl").description("wactl CLI — WhatsApp MCP server management").version("0.1.0");

program
  .command("status")
  .description("Show dashboard view")
  .action(async () => {
    try {
      const data = await fetchJSON("/api/status");
      const b = data.bridge || {};

      const connIcon = b.connected ? chalk.green("Connected") : chalk.red("Disconnected");
      const mcpPort = data.mcpPort || process.env.MCP_PORT || "3000";
      const mcpIcon = chalk.green(`Listening :${mcpPort}`);
      const apiKey = process.env.MCP_API_KEY || "not set";

      const lines = [
        `  WhatsApp     ${connIcon}`,
        `  Account      ${b.account || "Not logged in"}`,
        `  Uptime       ${formatUptime(b.uptime || 0)}`,
        "",
        `  MCP Server   ${mcpIcon}`,
        `  API Key      ${maskKey(apiKey)}`,
        `  Clients      ${data.mcpClients || 0}`,
      ];

      console.log(
        boxen(lines.join("\n"), {
          title: `wactl v0.1.0`,
          titleAlignment: "center",
          padding: 1,
          borderColor: "cyan",
          borderStyle: "round",
        })
      );
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

program
  .command("logs")
  .description("Tail live logs")
  .action(() => {
    try {
      execSync("journalctl -u wactl-bridge -u wactl-server -f --no-pager", {
        stdio: "inherit",
      });
    } catch {
      console.log(chalk.yellow("journalctl not available. Try: docker logs -f <container>"));
    }
  });

program
  .command("restart")
  .description("Restart bridge and server")
  .action(() => {
    try {
      console.log("Restarting services...");
      execSync("systemctl restart wactl-bridge wactl-server", { stdio: "inherit" });
      console.log(chalk.green("Services restarted"));
    } catch {
      console.log(chalk.yellow("systemctl not available. Try: docker restart <container>"));
    }
  });

program
  .command("update")
  .description("Trigger manual update check")
  .action(async () => {
    console.log("Triggering update check...");
    // The updater runs in the server process — just hint to check
    console.log(chalk.yellow("Manual update check is not yet implemented via CLI."));
    console.log("Check the admin dashboard for update status.");
  });

program
  .command("auth")
  .description("Show QR status and admin panel URL")
  .action(async () => {
    try {
      const data = await fetchJSON("/api/status");
      if (data.bridge?.connected) {
        console.log(chalk.green("Already connected to WhatsApp"));
        console.log(`Account: ${data.bridge.account}`);
      } else {
        console.log(chalk.yellow("Not connected — QR scan required"));
      }
      console.log(`\nAdmin Panel: ${chalk.cyan(`http://localhost:${ADMIN_PORT}/auth`)}`);
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
    }
  });

program
  .command("config")
  .description("Print current config (secrets redacted)")
  .action(() => {
    const envPath = path.resolve(process.cwd(), ".env");
    const secretKeys = ["MCP_API_KEY", "ADMIN_PASSWORD_HASH"];

    if (!fs.existsSync(envPath)) {
      // Try parent directories
      const altPath = path.resolve(__dirname, "../../.env");
      if (!fs.existsSync(altPath)) {
        console.log(chalk.yellow("No .env file found"));
        return;
      }
    }

    const envFile = fs.existsSync(envPath)
      ? envPath
      : path.resolve(__dirname, "../../.env");

    try {
      const content = fs.readFileSync(envFile, "utf-8");
      const lines = content.split("\n").map((line) => {
        for (const key of secretKeys) {
          if (line.startsWith(`${key}=`)) {
            return `${key}=****REDACTED****`;
          }
        }
        return line;
      });
      console.log(lines.join("\n"));
    } catch {
      console.log(chalk.yellow("Cannot read .env file"));
    }
  });

program.parse();
