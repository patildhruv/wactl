// Thin compatibility shim. The real tool metadata lives in toolDefinitions.ts
// so that the MCP server registration and any external callers share a single
// source of truth for names, descriptions, schemas, and handlers.
import { TOOLS, executeTool } from "./toolDefinitions";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// Legacy export: JSON-schema-ish view of the tools. Kept for any consumer that
// relied on the old shape; the SDK uses the Zod schemas from TOOLS directly.
export const toolDefinitions: ToolDefinition[] = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
}));

export { executeTool };
