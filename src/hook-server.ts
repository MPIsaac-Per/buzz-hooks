import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * Handlers for buzz's MCP-driven lifecycle hook convention
 * (docs/MCP_DRIVEN_HOOKS.md in block/buzz).
 *
 * Contract:
 * - `stop` runs when the LLM signals end_turn, before the agent honors it.
 *   Non-empty return = objection (agent keeps working). Empty = allow stop.
 * - `postCompact` runs after context compaction, before the next prompt.
 *   Non-empty return = injected into the fresh context.
 *
 * The agent enforces a per-call timeout (2.5s default) and a per-prompt
 * rejection budget (3 default). Handlers must return well inside the timeout;
 * a slow handler is treated as "no objection".
 */
export interface HookHandlers {
  stop: () => Promise<string>;
  postCompact?: () => Promise<string>;
}

function asToolResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function buildHookServer(
  name: string,
  version: string,
  handlers: HookHandlers,
): McpServer {
  const server = new McpServer({ name, version });

  server.registerTool(
    "_Stop",
    {
      description:
        "Lifecycle hook: called by the agent before honoring end_turn. " +
        "Non-empty text objects to stopping; empty text allows it.",
    },
    async () => asToolResult(await handlers.stop()),
  );

  if (handlers.postCompact) {
    const postCompact = handlers.postCompact;
    server.registerTool(
      "_PostCompact",
      {
        description:
          "Lifecycle hook: called after context compaction. Returned text " +
          "is injected into the fresh context.",
      },
      async () => asToolResult(await postCompact()),
    );
  }

  return server;
}

export async function serveHooks(
  name: string,
  version: string,
  handlers: HookHandlers,
): Promise<void> {
  const server = buildHookServer(name, version, handlers);
  await server.connect(new StdioServerTransport());
  // Keep the process alive; the transport closes when the agent disconnects.
}
