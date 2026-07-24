import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a command with a hard timeout. Hook calls must finish inside the
 * agent's hook timeout (2.5s default), so subprocess work gets a tighter
 * budget and is killed rather than awaited past it.
 */
export function run(
  command: string,
  args: string[],
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Behavior when a gate cannot evaluate its condition. */
export type ErrorPolicy = "object" | "allow";

export function errorPolicy(): ErrorPolicy {
  return process.env.GATE_ON_ERROR === "allow" ? "allow" : "object";
}

/** Apply the error policy: objection text under "object", empty under "allow". */
export function onError(detail: string): string {
  if (errorPolicy() === "allow") {
    console.error(`[buzz-hooks] check failed, allowing stop: ${detail}`);
    return "";
  }
  return `Gate could not verify its condition (${detail}). Fix the check or set GATE_ON_ERROR=allow.`;
}
