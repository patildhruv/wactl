import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import express from "express";
import cookieParser from "cookie-parser";
import http from "http";

import { BridgeClient } from "./bridge/client";
import { MCPServerWrapper } from "./mcp/server";
import { createAdminRouter } from "./admin/routes";
import { Notifier } from "./notify/ntfy";
import { AutoUpdater } from "./updater/index";

// Load .env from repo root (one directory above server/)
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || "4000", 10);
const MCP_PORT = parseInt(process.env.MCP_PORT || "3000", 10);
const ADMIN_PORT = parseInt(process.env.ADMIN_PORT || "8080", 10);
const MCP_API_KEY = process.env.MCP_API_KEY || "";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "";
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, "../../data");
const BRIDGE_DIR = process.env.BRIDGE_DIR || path.resolve(__dirname, "../../bridge");
const BASE_PATH = process.env.BASE_PATH || ""; // e.g. "/dhruv" for multi-instance

if (!MCP_API_KEY) {
  console.warn("[wactl] WARNING: MCP_API_KEY not set — MCP endpoint will reject all requests");
}
if (!ADMIN_PASSWORD_HASH) {
  console.warn("[wactl] WARNING: ADMIN_PASSWORD_HASH not set — admin login will not work");
}

// Ensure data directory exists
fs.mkdirSync(DATA_DIR, { recursive: true });

// Initialize components
const bridge = new BridgeClient(BRIDGE_PORT);
const mcpServer = new MCPServerWrapper(bridge, MCP_API_KEY);
const notifier = new Notifier({
  method: process.env.NOTIFY_METHOD || "none",
  ntfyTopic: process.env.NTFY_TOPIC,
  serverIP: process.env.SERVER_IP,
  serverHostname: process.env.SERVER_HOSTNAME,
  basePath: BASE_PATH,
  adminPort: ADMIN_PORT,
});

// --- MCP Server (SSE transport) ---
const mcpApp = express();

mcpApp.get("/mcp/sse", (req, res) => {
  mcpServer.handleSSE(req, res);
});

mcpApp.post("/mcp/messages", (req, res) => {
  mcpServer.handleMessages(req, res);
});

mcpApp.get("/health", (_req, res) => {
  res.json({ ok: true, service: "mcp" });
});

const mcpHttpServer = http.createServer(mcpApp);
mcpHttpServer.listen(MCP_PORT, () => {
  console.log(`[wactl] MCP server listening on port ${MCP_PORT}`);
});

// --- Admin Panel ---
const adminApp = express();
adminApp.use(cookieParser());

const envFilePath = process.env.ENV_FILE_PATH || path.resolve(__dirname, "../../.env");
const adminRouter = createAdminRouter(bridge, mcpServer, {
  adminUser: ADMIN_USER,
  adminPasswordHash: ADMIN_PASSWORD_HASH,
  mcpPort: MCP_PORT,
  dataDir: DATA_DIR,
  envFilePath,
  basePath: BASE_PATH,
});
adminApp.use(adminRouter);

adminApp.get("/health", (_req, res) => {
  res.json({ ok: true, service: "admin" });
});

const adminHttpServer = http.createServer(adminApp);
adminHttpServer.listen(ADMIN_PORT, () => {
  console.log(`[wactl] Admin panel listening on port ${ADMIN_PORT}`);
});

// --- Auto-updater ---
if (process.env.AUTO_UPDATE !== "false") {
  const updater = new AutoUpdater(DATA_DIR, BRIDGE_DIR, notifier);
  updater.start(process.env.AUTO_UPDATE_CRON || "0 3 * * *");
}

// --- Bridge callback handler ---
// Set up a simple callback endpoint that the Go bridge can POST events to
const CALLBACK_PORT = parseInt(process.env.CALLBACK_PORT || "4001", 10);
const callbackApp = express();
callbackApp.use(express.json());

callbackApp.post("/bridge/events", (req, res) => {
  const event = req.body?.event;
  console.log(`[wactl] Bridge event: ${event}`);

  if (event === "logged_out" || event === "stream_replaced") {
    notifier.notifyDisconnect(event);
  }

  res.json({ ok: true });
});

const callbackServer = http.createServer(callbackApp);
callbackServer.listen(CALLBACK_PORT, "127.0.0.1", () => {
  console.log(`[wactl] Bridge callback listener on port ${CALLBACK_PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[wactl] Shutting down...");
  mcpHttpServer.close();
  adminHttpServer.close();
  callbackServer.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[wactl] Interrupted, shutting down...");
  mcpHttpServer.close();
  adminHttpServer.close();
  callbackServer.close();
  process.exit(0);
});

console.log("[wactl] Server started successfully");
