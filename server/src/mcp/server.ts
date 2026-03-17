import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { IncomingMessage, ServerResponse } from "http";
import { z } from "zod";
import { BridgeClient } from "../bridge/client";
import { validateApiKey } from "./auth";
import { executeTool, toolDefinitions } from "./tools";

export class MCPServerWrapper {
  private server: McpServer;
  private bridge: BridgeClient;
  private apiKey: string;
  private transports: Map<string, SSEServerTransport> = new Map();

  constructor(bridge: BridgeClient, apiKey: string) {
    this.bridge = bridge;
    this.apiKey = apiKey;
    this.server = new McpServer({
      name: "wactl",
      version: "0.1.0",
    });

    this.registerTools();
  }

  private registerTools(): void {
    // list_chats
    this.server.tool(
      "list_chats",
      "List all WhatsApp conversations with last message preview",
      { limit: z.number().optional().describe("Maximum number of chats to return") },
      async (args) => {
        const result = await executeTool(this.bridge, "list_chats", args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
    );

    // get_chat
    this.server.tool(
      "get_chat",
      "Get message history for a specific chat",
      {
        chatId: z.string().describe("The chat JID"),
        limit: z.number().optional().describe("Maximum number of messages"),
      },
      async (args) => {
        const result = await executeTool(this.bridge, "get_chat", args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
    );

    // search_contacts
    this.server.tool(
      "search_contacts",
      "Search contacts by name or phone number",
      { query: z.string().describe("Search term") },
      async (args) => {
        const result = await executeTool(this.bridge, "search_contacts", args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
    );

    // send_message
    this.server.tool(
      "send_message",
      "Send a text message to a WhatsApp contact or group",
      {
        to: z.string().describe("Recipient JID or phone number"),
        body: z.string().describe("Message text"),
      },
      async (args) => {
        const result = await executeTool(this.bridge, "send_message", args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
    );

    // send_file
    this.server.tool(
      "send_file",
      "Send a file or image to a WhatsApp contact or group",
      {
        to: z.string().describe("Recipient JID or phone number"),
        filePath: z.string().describe("Absolute path to the file"),
        caption: z.string().optional().describe("Optional caption"),
      },
      async (args) => {
        const result = await executeTool(this.bridge, "send_file", args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
    );

    // download_media
    this.server.tool(
      "download_media",
      "Download media from a message",
      { messageId: z.string().describe("The message ID") },
      async (args) => {
        const result = await executeTool(this.bridge, "download_media", args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
    );

    // get_connection_status
    this.server.tool(
      "get_connection_status",
      "Check WhatsApp bridge connection status",
      {},
      async (args) => {
        const result = await executeTool(this.bridge, "get_connection_status", args);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
    );
  }

  async handleSSE(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!validateApiKey(req, this.apiKey)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or missing API key" }));
      return;
    }

    const transport = new SSEServerTransport("/mcp/messages", res);
    this.transports.set(transport.sessionId, transport);

    res.on("close", () => {
      this.transports.delete(transport.sessionId);
    });

    await this.server.connect(transport);
  }

  async handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const sessionId = url.searchParams.get("sessionId");

    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing sessionId" }));
      return;
    }

    const transport = this.transports.get(sessionId);
    if (!transport) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    await transport.handlePostMessage(req, res);
  }

  getConnectedClients(): number {
    return this.transports.size;
  }

  getApiKey(): string {
    return this.apiKey;
  }

  updateApiKey(newKey: string): void {
    this.apiKey = newKey;
  }
}
