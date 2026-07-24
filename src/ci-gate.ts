#!/usr/bin/env node
/**
 * buzz-ci-gate: a `_Stop` lifecycle hook server for buzz agents.
 *
 * Objects to end_turn while the latest GitHub Actions run for the watched
 * branch is failing or still running; allows it once the run is green.
 *
 * Config (env):
 *   CI_GATE_REPO      owner/repo to watch (required)
 *   CI_GATE_REF       branch to watch (default: current branch of CI_GATE_WORKDIR)
 *   CI_GATE_WORKDIR   git dir used to resolve the branch (default: cwd)
 *   CI_GATE_GH_BIN    gh binary (default: "gh"; used when GITHUB_TOKEN is unset)
 *   GITHUB_TOKEN      token for direct REST calls (preferred over gh)
 *   GATE_ON_ERROR     object | allow when the check itself fails (default: object)
 */
import { serveHooks } from "./hook-server.js";
import { run, onError } from "./run.js";

const CHECK_BUDGET_MS = 2000; // stay inside the agent's 2.5s hook timeout

export interface RunInfo {
  status: string; // queued | in_progress | completed | ...
  conclusion: string | null; // success | failure | cancelled | ...
  html_url?: string;
  run_number?: number;
}

/** Pure verdict: empty string allows the stop, non-empty objects. */
export function decide(latest: RunInfo | null): string {
  if (!latest) return ""; // no runs on this branch: nothing to gate
  if (latest.status !== "completed") {
    return `CI run #${latest.run_number ?? "?"} is still ${latest.status} (${latest.html_url ?? ""}). Do not end the turn until it completes; check again shortly.`;
  }
  if (latest.conclusion === "success") return "";
  return `CI is red: run #${latest.run_number ?? "?"} concluded ${latest.conclusion} (${latest.html_url ?? ""}). Investigate and fix before ending the turn.`;
}

async function currentBranch(workdir: string): Promise<string | null> {
  const r = await run(
    "git",
    ["-C", workdir, "rev-parse", "--abbrev-ref", "HEAD"],
    CHECK_BUDGET_MS,
  );
  return r.code === 0 ? r.stdout.trim() : null;
}

async function fetchLatestRun(
  repo: string,
  branch: string,
): Promise<RunInfo | null> {
  const path = `repos/${repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=1`;
  const token = process.env.GITHUB_TOKEN;
  let body: string;
  if (token) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CHECK_BUDGET_MS);
    try {
      const resp = await fetch(`https://api.github.com/${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
        },
        signal: ctl.signal,
      });
      if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
      body = await resp.text();
    } finally {
      clearTimeout(timer);
    }
  } else {
    const gh = process.env.CI_GATE_GH_BIN ?? "gh";
    const r = await run(gh, ["api", path], CHECK_BUDGET_MS);
    if (r.timedOut) throw new Error("gh api timed out");
    if (r.code !== 0) throw new Error(`gh api exited ${r.code}: ${r.stderr.slice(0, 200)}`);
    body = r.stdout;
  }
  const parsed = JSON.parse(body) as { workflow_runs?: RunInfo[] };
  return parsed.workflow_runs?.[0] ?? null;
}

async function checkOnce(): Promise<string> {
  const repo = process.env.CI_GATE_REPO;
  if (!repo) return onError("CI_GATE_REPO is not set");
  const branch =
    process.env.CI_GATE_REF ??
    (await currentBranch(process.env.CI_GATE_WORKDIR ?? process.cwd()));
  if (!branch) return onError("could not resolve branch to watch");
  try {
    return decide(await fetchLatestRun(repo, branch));
  } catch (err) {
    return onError(String(err).slice(0, 200));
  }
}

const isMain = process.argv[1]?.endsWith("ci-gate.js");
if (isMain) {
  serveHooks("buzz-ci-gate", "0.1.0", {
    stop: checkOnce,
    postCompact: async () => {
      const verdict = await checkOnce();
      return verdict === ""
        ? ""
        : `Reminder from ci-gate after context compaction: ${verdict}`;
    },
  }).catch((err) => {
    console.error(`[buzz-ci-gate] fatal: ${err}`);
    process.exit(1);
  });
}
