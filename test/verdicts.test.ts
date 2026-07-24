import { describe, expect, it } from "vitest";
import { decide, type RunInfo } from "../src/ci-gate.js";
import { isApproved, parseEventId } from "../src/approval-gate.js";

const run = (status: string, conclusion: string | null): RunInfo => ({
  status,
  conclusion,
  run_number: 7,
  html_url: "https://github.com/o/r/actions/runs/1",
});

describe("ci-gate decide", () => {
  it("allows when there are no runs", () => {
    expect(decide(null)).toBe("");
  });
  it("allows on green", () => {
    expect(decide(run("completed", "success"))).toBe("");
  });
  it("objects while running", () => {
    expect(decide(run("in_progress", null))).toMatch(/still in_progress/);
  });
  it("objects while queued", () => {
    expect(decide(run("queued", null))).toMatch(/still queued/);
  });
  it("objects on failure with the conclusion named", () => {
    expect(decide(run("completed", "failure"))).toMatch(/concluded failure/);
  });
  it("objects on cancelled", () => {
    expect(decide(run("completed", "cancelled"))).toMatch(/cancelled/);
  });
});

describe("approval-gate parseEventId", () => {
  const id = "a".repeat(64);
  it("reads id from JSON", () => {
    expect(parseEventId(JSON.stringify({ id }))).toBe(id);
  });
  it("reads event_id from JSON", () => {
    expect(parseEventId(JSON.stringify({ event_id: id }))).toBe(id);
  });
  it("falls back to a hex scan on non-JSON output", () => {
    expect(parseEventId(`sent ok: ${id}\n`)).toBe(id);
  });
  it("returns null when absent", () => {
    expect(parseEventId('{"ok":true}')).toBeNull();
  });
});

describe("approval-gate isApproved", () => {
  const groups = [
    { emoji: "👍", count: 2, pubkeys: ["alice", "bob"] },
    { emoji: "🎉", count: 1, pubkeys: ["mallory"] },
  ];
  it("approves when anyone may approve", () => {
    expect(isApproved(groups, "👍", null)).toBe(true);
  });
  it("rejects when the emoji is missing", () => {
    expect(isApproved(groups, "✅", null)).toBe(false);
  });
  it("respects the approver allowlist", () => {
    expect(isApproved(groups, "👍", ["carol"])).toBe(false);
    expect(isApproved(groups, "👍", ["bob"])).toBe(true);
  });
  it("ignores the right emoji from the wrong person", () => {
    expect(isApproved(groups, "🎉", ["alice"])).toBe(false);
  });
});
