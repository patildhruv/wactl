import { BridgeClient } from "../bridge/client";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "list_chats",
    description: "List all WhatsApp conversations with last message preview",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of chats to return",
        },
      },
    },
  },
  {
    name: "get_chat",
    description: "Get message history for a specific chat",
    inputSchema: {
      type: "object",
      properties: {
        chatId: {
          type: "string",
          description: "The chat JID (e.g., 1234567890@s.whatsapp.net)",
        },
        limit: {
          type: "number",
          description: "Maximum number of messages to return",
        },
      },
      required: ["chatId"],
    },
  },
  {
    name: "search_contacts",
    description: "Search contacts by name or phone number",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search term to match against contact names",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "send_message",
    description: "Send a text message to a WhatsApp contact or group",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description:
            "Recipient JID or phone number (e.g., 1234567890 or 1234567890@s.whatsapp.net)",
        },
        body: {
          type: "string",
          description: "The message text to send",
        },
      },
      required: ["to", "body"],
    },
  },
  {
    name: "send_file",
    description: "Send a file or image to a WhatsApp contact or group",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient JID or phone number",
        },
        filePath: {
          type: "string",
          description: "Absolute path to the file to send",
        },
        caption: {
          type: "string",
          description: "Optional caption for the file",
        },
      },
      required: ["to", "filePath"],
    },
  },
  {
    name: "download_media",
    description:
      "Download media (image, video, audio, document) from a message",
    inputSchema: {
      type: "object",
      properties: {
        messageId: {
          type: "string",
          description: "The message ID containing the media",
        },
      },
      required: ["messageId"],
    },
  },
  {
    name: "get_connection_status",
    description:
      "Check if the WhatsApp bridge is connected and get account info",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

export async function executeTool(
  bridge: BridgeClient,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (name) {
    case "list_chats": {
      const chats = await bridge.getChats();
      const limit = typeof args.limit === "number" ? args.limit : chats.length;
      return chats.slice(0, limit);
    }

    case "get_chat": {
      const chatId = args.chatId as string;
      const limit = typeof args.limit === "number" ? args.limit : 50;
      return bridge.getChatMessages(chatId, limit);
    }

    case "search_contacts": {
      const query = args.query as string;
      return bridge.getContacts(query);
    }

    case "send_message": {
      const to = args.to as string;
      const body = args.body as string;
      return bridge.sendMessage(to, body);
    }

    case "send_file": {
      const to = args.to as string;
      const filePath = args.filePath as string;
      const caption = args.caption as string | undefined;
      return bridge.sendFile(to, filePath, caption);
    }

    case "download_media": {
      const messageId = args.messageId as string;
      const dataDir = process.env.DATA_DIR || "./data";
      const fs = await import("fs");
      const path = await import("path");
      const mediaDir = path.join(dataDir, "downloads");
      fs.mkdirSync(mediaDir, { recursive: true });

      const data = await bridge.downloadMedia(messageId);
      const filePath = path.join(mediaDir, `${messageId}`);
      fs.writeFileSync(filePath, data);
      return { filePath, size: data.length };
    }

    case "get_connection_status": {
      return bridge.getStatus();
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
