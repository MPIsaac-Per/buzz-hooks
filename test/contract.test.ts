/**
 * Contract test: drive each built server over stdio exactly as buzz-agent
 * does — list tools, call `_Stop`, assert the objection/allow semantics and
 * that responses land well inside the agent's 2.5s hook timeout.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
const fakeBuzz = join(here, "fake-buzz.sh");

const HOOK_TIMEOUT_MS = 2500;

async function connect(script: string, env: Record<string, string>) {
  const client = new Client({ name: "contract-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(dist, script)],
    env: { ...process.env, ...env } as Record<string, string>,
  });
  await client.connect(transport);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content?.[0]?.text ?? "";
}

describe("ci-gate over stdio", () => {
  it("exposes _Stop and _PostCompact with the hook prefix", async () => {
    const client = await connect("ci-gate.js", { CI_GATE_REPO: "o/r" });
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["_PostCompact", "_Stop"]);
    await client.close();
  });

  it("objects on red CI and answers inside the hook timeout", async () => {
    const client = await connect("ci-gate.js", {
      CI_GATE_REPO: "o/r",
      CI_GATE_REF: "main",
      CI_GATE_GH_BIN: fakeBuzz,
      FAKE_MODE: "gh-red",
      GITHUB_TOKEN: "",
    });
    const started = Date.now();
    const result = await client.callTool({ name: "_Stop", arguments: {} });
    expect(Date.now() - started).toBeLessThan(HOOK_TIMEOUT_MS);
    expect(textOf(result)).toMatch(/CI is red/);
    await client.close();
  });

  it("allows the stop on green CI", async () => {
    const client = await connect("ci-gate.js", {
      CI_GATE_REPO: "o/r",
      CI_GATE_REF: "main",
      CI_GATE_GH_BIN: fakeBuzz,
      FAKE_MODE: "gh-green",
      GITHUB_TOKEN: "",
    });
    const result = await client.callTool({ name: "_Stop", arguments: {} });
    expect(textOf(result)).toBe("");
    await client.close();
  });
});

describe("approval-gate over stdio", () => {
  it("posts a request on first _Stop, objects until approved, then allows", async () => {
    const client = await connect("approval-gate.js", {
      APPROVAL_CHANNEL: "11111111-2222-3333-4444-555555555555",
      BUZZ_BIN: fakeBuzz,
      FAKE_MODE: "buzz-pending",
    });
    const first = await client.callTool({ name: "_Stop", arguments: {} });
    expect(textOf(first)).toMatch(/Approval requested/);

    const second = await client.callTool({ name: "_Stop", arguments: {} });
    expect(textOf(second)).toMatch(/Still awaiting/);
    await client.close();

    const approved = await connect("approval-gate.js", {
      APPROVAL_CHANNEL: "11111111-2222-3333-4444-555555555555",
      BUZZ_BIN: fakeBuzz,
      FAKE_MODE: "buzz-approved",
    });
    await approved.callTool({ name: "_Stop", arguments: {} }); // posts request
    const verdict = await approved.callTool({ name: "_Stop", arguments: {} });
    expect(textOf(verdict)).toBe("");
    await approved.close();
  });

  it("re-injects outstanding approval state via _PostCompact", async () => {
    const client = await connect("approval-gate.js", {
      APPROVAL_CHANNEL: "11111111-2222-3333-4444-555555555555",
      BUZZ_BIN: fakeBuzz,
      FAKE_MODE: "buzz-pending",
    });
    await client.callTool({ name: "_Stop", arguments: {} });
    const note = await client.callTool({ name: "_PostCompact", arguments: {} });
    expect(textOf(note)).toMatch(/approval request is outstanding/);
    await client.close();
  });
});

describe("approval-gate send_message tool", () => {
  it("is visible (no underscore prefix) and posts via the CLI", async () => {
    const client = await connect("approval-gate.js", {
      APPROVAL_CHANNEL: "11111111-2222-3333-4444-555555555555",
      BUZZ_BIN: fakeBuzz,
      FAKE_MODE: "buzz-pending",
    });
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("send_message");
    const result = await client.callTool({
      name: "send_message",
      arguments: { content: "hello from the gate" },
    });
    expect(textOf(result)).toMatch(/^sent \(event deadbeef/);
    await client.close();
  });
});

/**
 * Regression: the servers must start when invoked through their `bin` name,
 * an extensionless symlink created by `npm install -g` / `npm link`.
 * The contract tests above all spawn `node dist/<file>.js` directly, so they
 * cannot catch a main-module guard that only matches the `.js` path.
 */
describe("bin-name invocation (npm install -g path)", () => {
  const cases: Array<[string, string, Record<string, string>]> = [
    ["buzz-approval-gate", "approval-gate.js", { APPROVAL_CHANNEL: "11111111-2222-3333-4444-555555555555", BUZZ_BIN: fakeBuzz, FAKE_MODE: "buzz-pending" }],
    ["buzz-ci-gate", "ci-gate.js", { CI_GATE_REPO: "o/r", CI_GATE_REF: "main", CI_GATE_GH_BIN: fakeBuzz, FAKE_MODE: "gh-green" }],
  ];

  for (const [binName, distFile, env] of cases) {
    it(`${binName} serves when spawned via its extensionless bin symlink`, async () => {
      const { mkdtempSync, symlinkSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const dir = mkdtempSync(join(tmpdir(), "buzz-hooks-bin-"));
      const link = join(dir, binName);
      symlinkSync(join(dist, distFile), link);

      // Spawn through node with the symlink as argv[1]. That is the value the
      // main-module guard reads, so it reproduces the bin-name case exactly,
      // without depending on the exec bit (tsc does not set one; npm does).
      const client = new Client({ name: "bin-test", version: "0.0.0" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [link],
        env: { ...process.env, ...env } as Record<string, string>,
      });
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("_Stop");
      await client.close();
    });
  }
});
