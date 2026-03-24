import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import { z } from "zod";
import { BridgeClient } from "../bridge/client";
import { validateApiKey } from "./auth";
import { executeTool } from "./tools";
import { WactlOAuthProvider } from "./oauth";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";

/**
 * Creates a fresh McpServer with all WhatsApp tools registered.
 * Must be called once per transport connection — the SDK requires
 * a separate McpServer instance per transport.
 */
function createMcpServer(bridge: BridgeClient): McpServer {
  const server = new McpServer({
    name: "wactl",
    version: "0.1.0",
  });

  server.tool(
    "list_chats",
    "List all WhatsApp conversations with last message preview",
    { limit: z.number().optional().describe("Maximum number of chats to return") },
    async (args) => {
      const result = await executeTool(bridge, "list_chats", args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_chat",
    "Get message history for a specific chat",
    {
      chatId: z.string().describe("The chat JID"),
      limit: z.number().optional().describe("Maximum number of messages"),
    },
    async (args) => {
      const result = await executeTool(bridge, "get_chat", args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_contacts",
    "Search contacts by name or phone number",
    { query: z.string().describe("Search term") },
    async (args) => {
      const result = await executeTool(bridge, "search_contacts", args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "send_message",
    "Send a text message to a WhatsApp contact or group",
    {
      to: z.string().describe("Recipient JID or phone number"),
      body: z.string().describe("Message text"),
    },
    async (args) => {
      const result = await executeTool(bridge, "send_message", args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "send_file",
    "Send a file or image to a WhatsApp contact or group",
    {
      to: z.string().describe("Recipient JID or phone number"),
      filePath: z.string().describe("Absolute path to the file"),
      caption: z.string().optional().describe("Optional caption"),
    },
    async (args) => {
      const result = await executeTool(bridge, "send_file", args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "download_media",
    "Download media from a message",
    { messageId: z.string().describe("The message ID") },
    async (args) => {
      const result = await executeTool(bridge, "download_media", args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_connection_status",
    "Check WhatsApp bridge connection status",
    {},
    async (args) => {
      const result = await executeTool(bridge, "get_connection_status", args);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}

interface StreamableSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

interface SSESession {
  server: McpServer;
  transport: SSEServerTransport;
}

export class MCPServerWrapper {
  private bridge: BridgeClient;
  private apiKey: string;
  private basePath: string;
  private oauthProvider?: WactlOAuthProvider;
  private sseSessions: Map<string, SSESession> = new Map();
  private streamableSessions: Map<string, StreamableSession> = new Map();

  constructor(bridge: BridgeClient, apiKey: string, basePath: string = "", oauthProvider?: WactlOAuthProvider) {
    this.bridge = bridge;
    this.apiKey = apiKey;
    this.basePath = basePath;
    this.oauthProvider = oauthProvider;
  }

  /**
   * Validates auth via OAuth Bearer token or API key.
   * Returns true if authorized. On failure, sends 401 with WWW-Authenticate
   * header (triggers OAuth flow in Claude web).
   */
  private async validateAuth(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    // Try OAuth Bearer token first
    if (this.oauthProvider) {
      const authHeader = req.headers["authorization"];
      if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
        const token = authHeader.slice(7);
        try {
          await this.oauthProvider.verifyAccessToken(token);
          return true;
        } catch {
          // Token invalid — fall through to API key check
        }
      }
    }

    // Try API key (X-API-Key or Bearer)
    if (validateApiKey(req, this.apiKey)) {
      return true;
    }

    // Both failed — return 401
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.oauthProvider) {
      // Include resource_metadata URL to trigger OAuth discovery in Claude web
      const resourceUrl = new URL(`http://${req.headers.host || "localhost"}/mcp`);
      const metadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
      headers["WWW-Authenticate"] = `Bearer resource_metadata="${metadataUrl}"`;
    }
    res.writeHead(401, headers);
    res.end(JSON.stringify({ error: "Invalid or missing authentication" }));
    return false;
  }

  async handleSSE(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!(await this.validateAuth(req, res))) return;

    const server = createMcpServer(this.bridge);
    const transport = new SSEServerTransport(`${this.basePath}/mcp/messages`, res);
    this.sseSessions.set(transport.sessionId, { server, transport });

    res.on("close", () => {
      this.sseSessions.delete(transport.sessionId);
    });

    await server.connect(transport);
  }

  async handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("sessionId");

    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing sessionId" }));
      return;
    }

    const session = this.sseSessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    await session.transport.handlePostMessage(req, res);
  }

  async handleStreamableHTTP(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!(await this.validateAuth(req, res))) return;

    // Check for existing session
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (sessionId && this.streamableSessions.has(sessionId)) {
      const session = this.streamableSessions.get(sessionId)!;
      await session.transport.handleRequest(req, res, (req as any).body);
      return;
    }

    // New session — only via POST (initialization)
    if (req.method === "POST") {
      const server = createMcpServer(this.bridge);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          this.streamableSessions.delete(transport.sessionId);
        }
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, (req as any).body);

      if (transport.sessionId) {
        this.streamableSessions.set(transport.sessionId, { server, transport });
      }
      return;
    }

    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing or invalid Mcp-Session-Id header" }));
  }

  getConnectedClients(): number {
    return this.sseSessions.size + this.streamableSessions.size;
  }

  getApiKey(): string {
    return this.apiKey;
  }

  updateApiKey(newKey: string): void {
    this.apiKey = newKey;
  }
}
