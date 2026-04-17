import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import { BridgeClient } from "../bridge/client";
import { validateApiKey } from "./auth";
import { TOOLS } from "./toolDefinitions";
import { WactlOAuthProvider } from "./oauth";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";

/**
 * Creates a fresh McpServer with all WhatsApp tools registered.
 * Must be called once per transport connection — the SDK requires
 * a separate McpServer instance per transport.
 *
 * Tool metadata (name, description, schema, handler) lives in toolDefinitions.ts.
 * This function just wires each TOOL into the SDK and wraps the handler result
 * in the MCP content envelope.
 */
function createMcpServer(bridge: BridgeClient): McpServer {
  const server = new McpServer({
    name: "wactl",
    version: "0.1.0",
  });

  for (const def of TOOLS) {
    server.tool(def.name, def.description, def.schema, async (args: any) => {
      const result = await def.handler(bridge, args);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    });
  }

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

  private resourceServerUrl?: URL;

  constructor(bridge: BridgeClient, apiKey: string, basePath: string = "", oauthProvider?: WactlOAuthProvider, resourceServerUrl?: URL) {
    this.bridge = bridge;
    this.apiKey = apiKey;
    this.basePath = basePath;
    this.oauthProvider = oauthProvider;
    this.resourceServerUrl = resourceServerUrl;
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
      const metadataUrl = getOAuthProtectedResourceMetadataUrl(this.resourceServerUrl!);
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
