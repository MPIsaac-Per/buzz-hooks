# buzz-hooks

Gate-style lifecycle hook servers for [buzz](https://github.com/block/buzz) agents. Two MCP servers that stop an agent from ending its turn prematurely:

- **ci-gate** objects to `end_turn` while the latest GitHub Actions run on your branch is red or still running.
- **approval-gate** posts an approval request to a buzz channel and objects until a human reacts with the approval emoji.

These are the first third-party implementations of buzz's [MCP-driven lifecycle hook convention](https://github.com/block/buzz/blob/main/docs/MCP_DRIVEN_HOOKS.md). Block ships a first-party implementation in-tree (todo enforcement in `buzz-dev-mcp`); this repo shows the convention working from the outside, with no buzz code changes and no Rust.

## How the convention works

Any MCP server can expose tools whose names start with `_`. buzz-agent hides them from the LLM and calls them at lifecycle points:

| Hook | When | Semantics |
|---|---|---|
| `_Stop` | The LLM signals `end_turn`, before the agent honors it | Non-empty text = objection, agent keeps working. Empty = agent stops. |
| `_PostCompact` | After context compaction, before the next prompt | Returned text is injected into the fresh context. |

Hooks are off by default. The operator opts in with `MCP_HOOK_SERVERS=*` (or a comma-separated server allowlist) on the agent process.

## Install

```bash
npm install -g buzz-hooks
```

Register the server with your agent's MCP config (stdio command), then enable hooks. For buzz desktop managed agents, enabling MCP hooks sets `MCP_HOOK_SERVERS` for you; for a manual `buzz-agent` process:

```bash
MCP_HOOK_SERVERS=* buzz-agent ...
```

### ci-gate

```bash
CI_GATE_REPO=your-org/your-repo buzz-ci-gate
```

| Env | Default | Purpose |
|---|---|---|
| `CI_GATE_REPO` | (required) | `owner/repo` whose Actions runs are checked |
| `CI_GATE_REF` | current branch of `CI_GATE_WORKDIR` | Branch to watch |
| `CI_GATE_WORKDIR` | cwd | Git checkout used to resolve the branch |
| `GITHUB_TOKEN` | unset | Token for direct REST calls; falls back to the `gh` CLI |
| `GATE_ON_ERROR` | `object` | `allow` to fail open when the check itself errors |

### approval-gate

```bash
APPROVAL_CHANNEL=<channel-uuid> buzz-approval-gate
```

| Env | Default | Purpose |
|---|---|---|
| `APPROVAL_CHANNEL` | (required) | buzz channel UUID for the approval request |
| `APPROVAL_EMOJI` | 👍 | Reaction that approves |
| `APPROVAL_APPROVERS` | anyone | Comma-separated pubkeys allowed to approve |
| `APPROVAL_MESSAGE` | built-in text | Request message |
| `BUZZ_BIN` | `buzz` | buzz-cli binary used to post and read reactions |
| `GATE_ON_ERROR` | `object` | `allow` to fail open when a CLI call errors |

The server posts once per session, then checks reactions on each later `_Stop`. After context compaction, `_PostCompact` re-injects a note that the approval is still outstanding.

approval-gate also exposes one visible (non-hook) tool, `send_message`, which posts to the channel via buzz-cli. buzz-acp gives the agent a single MCP server slot; when this gate occupies it, `buzz-agent` loses the shell that `buzz-dev-mcp` provides and with it its reply path, so the gate carries one. Harnesses with their own shell (Goose, Codex, Claude Code) don't need it.

## What these gates can and cannot enforce

Read this before trusting a gate with anything that matters. The convention is deliberately advisory, and the agent stays sovereign:

- A hook call that exceeds the timeout (2.5s default) counts as no objection. The gate fails open on slowness.
- After 3 objections in one prompt (default), the agent stops regardless. A human who never reacts does not trap the agent; it also means the gate delays, not prevents, the stop.
- Hooks fire in `buzz-agent`. Sessions driven through the Goose, Codex, or Claude Code ACP harnesses do not call them.
- `_PreToolUse` (blocking individual tool calls) is deferred upstream pending MCP Interceptors (SEP-2624), so per-tool gating is not possible yet.

Hard enforcement lives elsewhere in buzz: relay-side branch protections can require N signed approvals before a merge, independent of what any agent does. Use these gates to shape agent behavior, and relay policy to enforce rules.

Both gates default to objecting when their own check fails (`GATE_ON_ERROR=object`), because a gate that cannot verify its condition should say so rather than silently pass. The rejection budget still caps the worst case.

## Portability

The pattern is not buzz-specific. `_Stop` maps to the `Stop` event in the [Open Plugin Spec](https://open-plugins.com/agent-builders/components/hooks), and Claude Code exposes native Stop hooks with the same shape: check a condition fast, object with a reason or stay silent. The verdict logic in `src/ci-gate.ts` (`decide`) and `src/approval-gate.ts` (`isApproved`) is dependency-free and ports directly.

## Development

```bash
npm install
npm test        # unit + stdio contract tests (fake gh/buzz CLIs, no network)
```

The contract tests drive each built server over stdio the same way buzz-agent does: list tools, call `_Stop`, assert objection/allow semantics and that responses return inside the hook timeout.

## License

Apache-2.0
