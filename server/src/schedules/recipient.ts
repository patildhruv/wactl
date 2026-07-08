import type { BridgeClient } from "../bridge/client";

export interface ResolvedRecipient {
  identity: string;
  jid: string;
}

/**
 * Resolve a phone / full JID / saved-contact-name into a canonical identity +
 * JID via the bridge. Shared by the schedule_create MCP tool and the Telegram
 * /new handler so recipient resolution behaves identically everywhere.
 */
export async function resolveRecipient(
  bridge: BridgeClient,
  to: string
): Promise<ResolvedRecipient> {
  const looksAddressable = to.includes("@") || /^[0-9+\s-]+$/.test(to);
  if (looksAddressable) {
    try {
      const m = await bridge.resolveJid(to.replace(/[\s-]/g, ""));
      return { identity: m.phone || m.user, jid: m.jid };
    } catch {
      // fall through to contact search
    }
  }
  const contacts = await bridge.getContacts(to);
  if (contacts.length > 0) {
    const c = contacts[0];
    return { identity: c.number || c.id.split("@")[0], jid: c.id };
  }
  throw new Error(
    `could not resolve recipient '${to}' — pass a phone number, a full JID, or a saved contact name`
  );
}
