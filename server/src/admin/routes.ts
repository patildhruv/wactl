import express, { Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import cookieParser from "cookie-parser";
import {
  checkRateLimit,
  verifyPassword,
  createSession,
  validateSession,
  destroySession,
} from "./auth";
import { BridgeClient } from "../bridge/client";
import { MCPServerWrapper } from "../mcp/server";

const VIEWS_DIR = path.join(__dirname, "views");

export function createAdminRouter(
  bridge: BridgeClient,
  mcpServer: MCPServerWrapper,
  config: {
    adminUser: string;
    adminPasswordHash: string;
    mcpPort: number;
    dataDir: string;
  }
): express.Router {
  const router = express.Router();

  // Serve static HTML views
  const loginHTML = fs.readFileSync(path.join(VIEWS_DIR, "login.html"), "utf-8");
  const dashboardHTML = fs.readFileSync(path.join(VIEWS_DIR, "dashboard.html"), "utf-8");
  const qrAuthHTML = fs.readFileSync(path.join(VIEWS_DIR, "qr-auth.html"), "utf-8");

  // Check if request is from localhost (used for CLI access without auth)
  function isLocalhost(req: Request): boolean {
    const addr = req.socket.remoteAddress || "";
    return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  }

  // Auth middleware for protected routes
  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const sessionId = req.cookies?.session;
    if (!sessionId || !validateSession(sessionId)) {
      if (req.path.startsWith("/api/")) {
        res.status(401).json({ error: "Unauthorized" });
      } else {
        res.redirect("/login");
      }
      return;
    }
    next();
  }

  // Auth middleware that allows localhost access (for CLI)
  function requireAuthOrLocal(req: Request, res: Response, next: NextFunction): void {
    if (isLocalhost(req)) {
      next();
      return;
    }
    requireAuth(req, res, next);
  }

  // --- Public routes ---

  router.get("/login", (_req: Request, res: Response) => {
    res.type("html").send(loginHTML);
  });

  router.post("/login", express.json(), async (req: Request, res: Response) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    if (!checkRateLimit(ip)) {
      res.status(429).json({ error: "Too many login attempts. Try again in a minute." });
      return;
    }

    const { username, password } = req.body;
    if (username !== config.adminUser) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const valid = await verifyPassword(password, config.adminPasswordHash);
    if (!valid) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const sessionId = createSession();
    res.cookie("session", sessionId, {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      sameSite: "lax",
    });
    res.json({ ok: true });
  });

  router.post("/logout", (req: Request, res: Response) => {
    const sessionId = req.cookies?.session;
    if (sessionId) {
      destroySession(sessionId);
    }
    res.clearCookie("session");
    res.json({ ok: true });
  });

  // --- Protected routes ---

  router.get("/", requireAuth, (_req: Request, res: Response) => {
    res.type("html").send(dashboardHTML);
  });

  router.get("/auth", requireAuth, (_req: Request, res: Response) => {
    res.type("html").send(qrAuthHTML);
  });

  // --- API routes (protected) ---

  router.get("/api/status", requireAuthOrLocal, async (_req: Request, res: Response) => {
    try {
      const bridgeStatus = await bridge.getStatus();
      const updateHistoryPath = path.join(config.dataDir, "update-history.json");
      let updateHistory: unknown[] = [];
      try {
        const raw = fs.readFileSync(updateHistoryPath, "utf-8");
        updateHistory = JSON.parse(raw);
      } catch {
        // No update history file yet
      }

      res.json({
        bridge: bridgeStatus,
        mcpPort: config.mcpPort,
        mcpClients: mcpServer.getConnectedClients(),
        updateHistory,
      });
    } catch (err) {
      res.json({
        bridge: { connected: false, loggedIn: false, uptime: 0, account: "" },
        mcpPort: config.mcpPort,
        mcpClients: 0,
        updateHistory: [],
        error: "Bridge unreachable",
      });
    }
  });

  router.get("/api/qr", requireAuthOrLocal, async (_req: Request, res: Response) => {
    try {
      const qr = await bridge.getQR();
      res.json(qr);
    } catch {
      res.json({ qr: null, expiresAt: null });
    }
  });

  router.post("/api/bridge-logout", requireAuth, async (_req: Request, res: Response) => {
    try {
      await bridge.logout();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to logout bridge" });
    }
  });

  return router;
}
