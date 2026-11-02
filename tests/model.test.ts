import { describe, expect, test } from "bun:test";
import {
  branchFor,
  canTransition,
  defaultPrefix,
  FINAL_STATES,
  slugify,
  TASK_STATES,
  transition,
  TRANSITIONS,
  type Task,
  type TaskState,
} from "../src/model.ts";

function task(state: TaskState, extra: Partial<Task> = {}): Task {
  return {
    id: "QHQ-1",
    title: "t",
    brief: "b",
    state,
    repo: "/r",
    branch: "coord/qhq-1-t",
    dependsOn: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

describe("state machine", () => {
  test("every state has a transition entry, and targets are real states", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...TASK_STATES].sort());
    for (const targets of Object.values(TRANSITIONS)) {
      for (const t of targets) expect(TASK_STATES).toContain(t);
    }
  });

  test("the happy path is allowed", () => {
    const path: TaskState[] = ["todo", "queued", "starting", "working", "needs_you", "working", "done"];
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
  });

  test("done is final; failed and cancelled only reopen to todo", () => {
    expect(TRANSITIONS.done).toEqual([]);
    expect(TRANSITIONS.failed).toEqual(["todo"]);
    expect(TRANSITIONS.cancelled).toEqual(["todo"]);
    for (const s of FINAL_STATES) expect(canTransition(s, "working")).toBe(false);
  });

  test("nothing skips straight from todo/queued to working or done", () => {
    for (const from of ["todo", "queued"] as const) {
      expect(canTransition(from, "working")).toBe(false);
      expect(canTransition(from, "done")).toBe(false);
    }
  });

  test("no self-transitions", () => {
    for (const s of TASK_STATES) expect(canTransition(s, s)).toBe(false);
  });

  test("transition() updates the task and returns an event", () => {
    const t = task("working");
    const ev = transition(t, "done", "2026-02-02T00:00:00.000Z", { summary: "ok" });
    expect(t.state).toBe("done");
    expect(t.updatedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(ev).toEqual({ type: "task.state", task: "QHQ-1", from: "working", to: "done", data: { summary: "ok" } });
  });

  test("transition() clears needsYouReason when leaving needs_you", () => {
    const t = task("needs_you", { needsYouReason: "which DB?" });
    transition(t, "working", "now");
    expect(t.needsYouReason).toBeUndefined();
  });

  test("transition() refuses a disallowed move and leaves the task alone", () => {
    const t = task("done");
    expect(() => transition(t, "working", "now")).toThrow("QHQ-1 is done; it can't become working (it's final)");
    expect(t.state).toBe("done");
    expect(() => transition(task("todo"), "done", "now")).toThrow("allowed: queued, starting, cancelled");
  });
});

describe("names", () => {
  test("slugify", () => {
    expect(slugify("  Fix the Login bug!! ")).toBe("fix-the-login-bug");
    expect(slugify("Café déjà vu")).toBe("cafe-deja-vu");
    expect(slugify("a".repeat(60))).toHaveLength(40);
    expect(slugify("!!!")).toBe("");
  });

  test("branchFor", () => {
    expect(branchFor("QHQ-12", "Add OAuth login")).toBe("coord/qhq-12-add-oauth-login");
    expect(branchFor("QHQ-3", "???")).toBe("coord/qhq-3");
  });

  test("defaultPrefix", () => {
    expect(defaultPrefix("quarterly hq")).toBe("QH");
    expect(defaultPrefix("Quiet Harbour Quay")).toBe("QHQ");
    expect(defaultPrefix("website")).toBe("WEB");
    expect(defaultPrefix("2048 game")).toBe("P2G");
  });
});
