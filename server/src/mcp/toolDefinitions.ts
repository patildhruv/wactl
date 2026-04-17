import { z } from "zod";
import { BridgeClient } from "../bridge/client";
import fs from "fs";
import path from "path";

/**
 * Single source of truth for MCP tool metadata. Both `tools.ts` (the dispatch
 * table used by tests) and `server.ts` (MCP SDK registration) consume this
 * module so descriptions, schemas, and handlers stay in lockstep.
 *
 * Descriptions are written as prompts — an LLM reading them alone should be
 * able to call the tool correctly without trial-and-error. Every description
 * that involves JIDs includes the same glossary so the LLM builds the right
 * mental model up front.
 */

const JID_GLOSSARY = `JID glossary:
  @s.whatsapp.net = phone-number JID (DMs)
  @lid            = anonymized Linked-ID (common in groups; the same person may appear
                    as a phone JID in their DM and a LID in a group — these are NOT
                    two different people). Use resolve_jid to map an @lid to a phone.
  @g.us           = group
  @newsletter     = channel
  @broadcast      = status updates`;

// Companion tools (resolve_jid, list_group_participants, search_messages,
// get_message) are surfaced by every wactl server, but some MCP clients
// (notably Claude.ai) list tools by name without loading their schemas.
// When a referenced tool isn't immediately callable in your client, use the
// client's tool-discovery mechanism (e.g. `tool_search` on Claude.ai) before
// calling it.
const DISCOVERY_NOTE =
  "Note on referenced tools: if resolve_jid / list_group_participants / " +
  "search_messages / get_message appear by name in your tool list but aren't " +
  "directly callable, your MCP client is loading schemas lazily — surface them " +
  "via its tool-discovery mechanism (e.g. `tool_search` on Claude.ai) first.";

const RETURN_SHAPE_NOTE =
  "Timestamps are Unix epoch seconds (UTC). `from` is the bare user-part; " +
  "`fromJid` gives you the full JID (so you can tell phone vs lid); " +
  "`fromPhone` is the resolved phone when `fromType` is 'lid' and we have a mapping. " +
  "`senderName` is the best display name (saved contact > push name); " +
  "`senderSavedName` and `senderPushName` are separated so you can tell which was used.";

export interface ToolDef<Args = unknown> {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (bridge: BridgeClient, args: Args) => Promise<unknown>;
}

export const TOOLS: ToolDef<any>[] = [
  {
    name: "list_chats",
    description: `List all WhatsApp conversations, most recently active first.

${JID_GLOSSARY}

Parameters:
  limit (number, optional): return at most this many chats (default: all).

Returns: [{ id (JID), name, lastMessage (preview), timestamp (unix sec UTC), unread }]

Note: \`name\` resolves to the saved contact name when available, otherwise the push name, otherwise the bare JID.`,
    schema: {
      limit: z
        .number()
        .optional()
        .describe("Maximum number of chats to return"),
    },
    handler: async (bridge, args: { limit?: number }) => {
      const chats = await bridge.getChats();
      return typeof args.limit === "number" ? chats.slice(0, args.limit) : chats;
    },
  },

  {
    name: "get_chat",
    description: `Get message history for a specific chat, newest first.

${JID_GLOSSARY}

Parameters:
  chatId (string, required): full JID from list_chats. DMs end in @s.whatsapp.net, groups in @g.us.
  limit (number, optional, default 50, max 500): newest N messages.
  before (number, optional): Unix timestamp (seconds). Returns messages strictly before this — use for pagination. Pass the timestamp of the oldest message from your previous call.

Returns: [{ id, body, timestamp, isFromMe, hasMedia, mediaType?, quotedMessageId?,
  from (bare user-part), fromJid, fromType ("phone"|"lid"), fromPhone?,
  senderName?, senderPushName?, senderSavedName? }]

${RETURN_SHAPE_NOTE}

Note: in group chats, \`fromJid\` is usually an @lid. Use \`fromPhone\` (when present) or \`resolve_jid\` to map to a phone number. Two messages with different user-parts do NOT imply two different people — the same person can appear under both a phone and a LID.

${DISCOVERY_NOTE}`,
    schema: {
      chatId: z
        .string()
        .describe(
          "Full chat JID, obtained from list_chats. Groups end in @g.us, DMs in @s.whatsapp.net, channels in @newsletter."
        ),
      limit: z
        .number()
        .optional()
        .describe("Maximum messages to return (default 50, max 500)"),
      before: z
        .number()
        .optional()
        .describe(
          "Unix epoch seconds — return messages strictly older than this. Use for pagination."
        ),
    },
    handler: async (
      bridge,
      args: { chatId: string; limit?: number; before?: number }
    ) => {
      const limit = typeof args.limit === "number" ? args.limit : 50;
      return bridge.getChatMessages(args.chatId, limit, args.before);
    },
  },

  {
    name: "search_contacts",
    description: `Search the saved address book (push names + full names + phone substrings).

Parameters:
  query (string, required): case-insensitive substring. Empty string returns all saved contacts (up to 50).

Returns: [{ id (JID), name, number (bare phone), isGroup }]

Note: this tool searches SAVED contacts only. It does NOT search:
  • Group-only participants who aren't in your address book — use \`list_group_participants\` on a group JID for that.
  • People mentioned in messages but not saved — use \`search_messages\` to find them by what they've said.
If you get an empty result, consider searching messages next.

${DISCOVERY_NOTE}`,
    schema: {
      query: z
        .string()
        .describe(
          "Substring to match against saved contact name or phone. Case-insensitive. Pass empty string to list all saved contacts (capped at 50)."
        ),
    },
    handler: async (bridge, args: { query: string }) => {
      return bridge.getContacts(args.query);
    },
  },

  {
    name: "resolve_jid",
    description: `Resolve a JID (phone, LID, or bare user-part) to full identity metadata.

${JID_GLOSSARY}

Parameters:
  jid (string, required): a full JID ("70935881228289@lid", "918983298987@s.whatsapp.net") or a bare user-part ("918983298987" — assumed phone).

Returns: { jid, type ("phone"|"lid"), user, phone?, pushName?, savedName? }

Use this when you have an @lid from a group message and want to know who the person is. If \`phone\` is populated, you can then call \`get_chat\` with \`<phone>@s.whatsapp.net\` to see their DM history.`,
    schema: {
      jid: z
        .string()
        .describe(
          "Full JID (ending in @lid, @s.whatsapp.net) or bare user-part."
        ),
    },
    handler: async (bridge, args: { jid: string }) => {
      return bridge.resolveJid(args.jid);
    },
  },

  {
    name: "list_group_participants",
    description: `List all members of a WhatsApp group with enriched identity metadata.

Parameters:
  chatId (string, required): a group JID (ends in @g.us — use list_chats or search for the group name first).

Returns: [{ jid, type ("phone"|"lid"), user, phone?, pushName?, savedName?, isAdmin, isSuperAdmin }]

Note: each participant entry includes both the JID form they appear under (often @lid) and the resolved phone when known. Useful to map group-only participants to their real contact info, or to find who an @lid in a get_chat response belongs to.`,
    schema: {
      chatId: z
        .string()
        .describe(
          "Group JID ending in @g.us. Obtain from list_chats or search_contacts."
        ),
    },
    handler: async (bridge, args: { chatId: string }) => {
      return bridge.listGroupParticipants(args.chatId);
    },
  },

  {
    name: "search_messages",
    description: `Full-text search across stored messages, newest first.

${JID_GLOSSARY}

Parameters:
  query (string, optional): case-insensitive substring to match in message body.
  chatId (string, optional): restrict to a single chat JID.
  from (string, optional): sender user-part (bare phone or LID) to restrict by author.
  since (number, optional): Unix epoch seconds — messages at or after this time.
  until (number, optional): Unix epoch seconds — messages at or before this time.
  limit (number, optional, default 50, max 500): result cap.

Returns: [MessageRecord] — same enriched shape as get_chat, with \`chatJid\` included so you can trace each result back to its conversation.

${RETURN_SHAPE_NOTE}

Use this instead of pulling hundreds of messages from get_chat when looking for specific content. Combine with resolve_jid to follow up on an @lid you found.

${DISCOVERY_NOTE}`,
    schema: {
      query: z
        .string()
        .optional()
        .describe("Case-insensitive substring match on message body"),
      chatId: z
        .string()
        .optional()
        .describe("Restrict results to a single chat JID"),
      from: z
        .string()
        .optional()
        .describe(
          "Restrict to a single sender user-part (bare phone or LID — use just the user portion, not the full JID)"
        ),
      since: z
        .number()
        .optional()
        .describe("Unix epoch seconds — return messages at or after this time"),
      until: z
        .number()
        .optional()
        .describe(
          "Unix epoch seconds — return messages at or before this time"
        ),
      limit: z
        .number()
        .optional()
        .describe("Max results (default 50, max 500)"),
    },
    handler: async (
      bridge,
      args: {
        query?: string;
        chatId?: string;
        from?: string;
        since?: number;
        until?: number;
        limit?: number;
      }
    ) => {
      return bridge.searchMessages({
        query: args.query,
        chatJid: args.chatId,
        from: args.from,
        since: args.since,
        until: args.until,
        limit: args.limit,
      });
    },
  },

  {
    name: "get_message",
    description: `Fetch a single message by its ID. Useful for resolving quotedMessageId references without scanning a whole chat.

Parameters:
  messageId (string, required): the \`id\` from any MessageRecord (e.g. returned by get_chat or search_messages).

Returns: MessageRecord with \`chatJid\` populated so you know which conversation it belongs to.

${RETURN_SHAPE_NOTE}`,
    schema: {
      messageId: z
        .string()
        .describe(
          "Message ID from a previous get_chat / search_messages response"
        ),
    },
    handler: async (bridge, args: { messageId: string }) => {
      return bridge.getMessage(args.messageId);
    },
  },

  {
    name: "send_message",
    description: `Send a text message to a contact or group.

Parameters:
  to (string, required): recipient. Accepts a bare phone ("918983298987"), a full phone JID ("918983298987@s.whatsapp.net"), or a group JID ("...@g.us"). Bare strings default to @s.whatsapp.net.
  body (string, required): message text.

Returns: { messageId, timestamp (unix sec UTC) }`,
    schema: {
      to: z
        .string()
        .describe(
          "Recipient: bare phone number, full JID, or group JID (@g.us)"
        ),
      body: z.string().describe("Message text"),
    },
    handler: async (bridge, args: { to: string; body: string }) => {
      return bridge.sendMessage(args.to, args.body);
    },
  },

  {
    name: "send_file",
    description: `Send a file (image, video, audio, document) to a contact or group.

Parameters:
  to (string, required): recipient JID or phone (same rules as send_message).
  filePath (string, required): absolute path to the file on the bridge host.
  caption (string, optional): caption shown below the media.

Returns: { messageId, timestamp }

Note: the file must be accessible from the server running wactl — not the LLM's environment.`,
    schema: {
      to: z.string().describe("Recipient JID or phone number"),
      filePath: z.string().describe("Absolute path to the file on the server"),
      caption: z.string().optional().describe("Optional caption"),
    },
    handler: async (
      bridge,
      args: { to: string; filePath: string; caption?: string }
    ) => {
      return bridge.sendFile(args.to, args.filePath, args.caption);
    },
  },

  {
    name: "download_media",
    description: `Download media (image, video, audio, document) attached to a message. Saves to the server's DATA_DIR/downloads.

Parameters:
  messageId (string, required): the \`id\` of a message where \`hasMedia\` is true.

Returns: { filePath, size } — absolute path on the server + byte size.

Note: the returned path lives on the bridge host, not the LLM's environment. Use send_file to route it somewhere else, or fetch via the admin panel.`,
    schema: {
      messageId: z.string().describe("Message ID whose media you want"),
    },
    handler: async (bridge, args: { messageId: string }) => {
      const dataDir = process.env.DATA_DIR || "./data";
      const mediaDir = path.join(dataDir, "downloads");
      fs.mkdirSync(mediaDir, { recursive: true });

      const data = await bridge.downloadMedia(args.messageId);
      const filePath = path.join(mediaDir, args.messageId);
      fs.writeFileSync(filePath, data);
      return { filePath, size: data.length };
    },
  },

  {
    name: "get_connection_status",
    description: `Check if the WhatsApp bridge is connected and report the account.

Parameters: none.

Returns: { account (phone user-part), connected, loggedIn, uptime (seconds) }`,
    schema: {},
    handler: async (bridge) => bridge.getStatus(),
  },
];

export async function executeTool(
  bridge: BridgeClient,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return def.handler(bridge, args);
}
