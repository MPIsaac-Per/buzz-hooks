import { appendFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * True when `moduleUrl` is the process entrypoint.
 *
 * `npm install -g` and `npm link` expose each gate through an extensionless
 * `bin` symlink (`buzz-approval-gate`), so comparing `process.argv[1]` against
 * a `.js` suffix silently fails there: the guard is false, the server never
 * starts, and the process exits 0 with no output. Resolve the symlink and
 * compare file URLs instead, which holds for `node dist/x.js`, the bin
 * symlink, and a global install alike.
 */
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

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

/**
 * Hook servers run as children of the agent, so their stderr is usually
 * invisible. Set GATE_LOG=/path/to/file to append one JSON line per hook
 * call: timestamp, hook name, latency, and the verdict.
 */
function logCall(hook: string, ms: number, text: string): void {
  const path = process.env.GATE_LOG;
  if (!path) return;
  try {
    appendFileSync(
      path,
      JSON.stringify({
        ts: new Date().toISOString(),
        hook,
        ms,
        verdict: text === "" ? "allow" : "object",
        detail: text.slice(0, 160),
      }) + "\n",
    );
  } catch {
    // logging must never break a hook call
  }
}

async function timed(hook: string, fn: () => Promise<string>) {
  const started = Date.now();
  const text = await fn();
  logCall(hook, Date.now() - started, text);
  return asToolResult(text);
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
    async () => timed("_Stop", handlers.stop),
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
      async () => timed("_PostCompact", postCompact),
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
