#!/usr/bin/env node
/**
 * buzz-approval-gate: a `_Stop` lifecycle hook server for buzz agents.
 *
 * On the first end_turn attempt it posts an approval request to a buzz
 * channel (via buzz-cli) and objects. On later attempts it checks reactions
 * on that message; once an approver reacts with the approval emoji, the
 * agent is allowed to stop.
 *
 * Config (env):
 *   APPROVAL_CHANNEL    buzz channel UUID to post into (required)
 *   APPROVAL_EMOJI      emoji that approves (default: 👍)
 *   APPROVAL_APPROVERS  comma-separated pubkeys allowed to approve (default: anyone)
 *   APPROVAL_MESSAGE    request text (default provided)
 *   BUZZ_BIN            buzz-cli binary (default: "buzz")
 *   GATE_ON_ERROR       object | allow when a CLI call fails (default: object)
 */
import { serveHooks } from "./hook-server.js";
import { run, onError } from "./run.js";

const CLI_BUDGET_MS = 2000; // stay inside the agent's 2.5s hook timeout

export interface ReactionGroup {
  emoji: string;
  count: number;
  pubkeys: string[];
}

/** Extract a 64-hex nostr event id from buzz-cli write output. */
export function parseEventId(cliOutput: string): string | null {
  try {
    const parsed = JSON.parse(cliOutput) as Record<string, unknown>;
    for (const key of ["id", "event_id", "eventId"]) {
      const v = parsed[key];
      if (typeof v === "string" && /^[0-9a-f]{64}$/.test(v)) return v;
    }
  } catch {
    // fall through to regex scan
  }
  const m = cliOutput.match(/\b[0-9a-f]{64}\b/);
  return m ? m[0] : null;
}

/** Pure verdict: has an allowed pubkey reacted with the approval emoji? */
export function isApproved(
  groups: ReactionGroup[],
  emoji: string,
  approvers: string[] | null,
): boolean {
  const g = groups.find((x) => x.emoji === emoji);
  if (!g || g.count === 0) return false;
  if (!approvers || approvers.length === 0) return true;
  return g.pubkeys.some((p) => approvers.includes(p));
}

interface State {
  requestEventId: string | null;
  approved: boolean;
}

export function makeHandlers(state: State) {
  const buzzBin = () => process.env.BUZZ_BIN ?? "buzz";
  const emoji = () => process.env.APPROVAL_EMOJI ?? "👍";
  const approvers = () => {
    const raw = process.env.APPROVAL_APPROVERS?.trim();
    return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : null;
  };

  async function requestApproval(): Promise<string> {
    const channel = process.env.APPROVAL_CHANNEL;
    if (!channel) return onError("APPROVAL_CHANNEL is not set");
    const text =
      process.env.APPROVAL_MESSAGE ??
      `Agent requests approval to end its turn. React with ${emoji()} to approve.`;
    const r = await run(
      buzzBin(),
      ["messages", "send", "--channel", channel, "--content", text],
      CLI_BUDGET_MS,
    );
    if (r.timedOut || r.code !== 0) {
      return onError(`buzz messages send failed: ${r.stderr.slice(0, 200)}`);
    }
    const id = parseEventId(r.stdout);
    if (!id) return onError("could not parse event id from buzz-cli output");
    state.requestEventId = id;
    return `Approval requested in channel (event ${id.slice(0, 8)}…). A human must react with ${emoji()} before the turn can end. Keep working on remaining tasks or check again.`;
  }

  async function checkApproval(): Promise<string> {
    const id = state.requestEventId;
    if (!id) return requestApproval();
    const r = await run(
      buzzBin(),
      ["reactions", "get", "--event", id],
      CLI_BUDGET_MS,
    );
    if (r.timedOut || r.code !== 0) {
      return onError(`buzz reactions get failed: ${r.stderr.slice(0, 200)}`);
    }
    let groups: ReactionGroup[] = [];
    try {
      const parsed = JSON.parse(r.stdout) as unknown;
      if (Array.isArray(parsed)) groups = parsed as ReactionGroup[];
      else if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { reactions?: unknown }).reactions)
      ) {
        groups = (parsed as { reactions: ReactionGroup[] }).reactions;
      }
    } catch {
      return onError("could not parse reactions output");
    }
    if (isApproved(groups, emoji(), approvers())) {
      state.approved = true;
      return "";
    }
    return `Still awaiting ${emoji()} approval on event ${id.slice(0, 8)}…. Keep working or check again.`;
  }

  return {
    stop: async (): Promise<string> => {
      if (state.approved) return "";
      return checkApproval();
    },
    postCompact: async (): Promise<string> => {
      if (state.approved || !state.requestEventId) return "";
      return `Note from approval-gate after context compaction: an approval request is outstanding (event ${state.requestEventId.slice(0, 8)}…). The turn cannot end until a human reacts with ${emoji()}.`;
    },
  };
}

const isMain = process.argv[1]?.endsWith("approval-gate.js");
if (isMain) {
  const state: State = { requestEventId: null, approved: false };
  serveHooks("buzz-approval-gate", "0.1.0", makeHandlers(state)).catch(
    (err) => {
      console.error(`[buzz-approval-gate] fatal: ${err}`);
      process.exit(1);
    },
  );
}
