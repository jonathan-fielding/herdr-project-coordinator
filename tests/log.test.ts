import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findTranscript, renderTranscript } from "../src/log.ts";
import { cli, tempDir, tempRepo } from "./helpers.ts";

const SESSION = "0b6d3f9e-1c2a-4e5f-8a7b-9c0d1e2f3a4b";
const ts = (m: number) => `2026-11-02T10:${String(m).padStart(2, "0")}:00.000Z`;

/** A transcript shaped like Claude Code 2.1.316's: bookkeeping lines, text, tool calls and results. */
const lines = [
  { type: "mode", mode: "normal", sessionId: SESSION },
  { type: "user", timestamp: ts(0), message: { role: "user", content: "You are a worker agent…\nTask: DM-1 Form\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10" } },
  { type: "assistant", timestamp: ts(1), message: { content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "I'll look at the code first." }] } },
  { type: "assistant", timestamp: ts(1), message: { content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "ls src", description: "List source files" } }] } },
  { type: "user", timestamp: ts(1), message: { content: [{ type: "tool_result", tool_use_id: "a", content: "app.ts\nform.ts" }] } },
  { type: "assistant", timestamp: ts(2), message: { content: [{ type: "tool_use", id: "b", name: "Edit", input: { file_path: "/w/src/form.ts", old_string: "x", new_string: "y" } }] } },
  { type: "user", timestamp: ts(2), message: { content: [{ type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: "ok" }] }] } },
  { type: "assistant", timestamp: ts(3), message: { content: [{ type: "tool_use", id: "c", name: "Bash", input: { command: "bun test" } }] } },
  { type: "user", timestamp: ts(3), message: { content: [{ type: "tool_result", tool_use_id: "c", is_error: true, content: Array.from({ length: 30 }, (_, i) => `fail ${i}`).join("\n") }] } },
  { type: "user", timestamp: ts(4), message: { content: '<hc from="t3 coord-dm-root">use the old API</hc>' } },
  { type: "assistant", timestamp: ts(5), isSidechain: true, message: { content: [{ type: "text", text: "a subagent's inner turn" }] } },
  { type: "assistant", timestamp: ts(5), message: { content: [{ type: "text", text: "Done; reporting." }] } },
].map((l) => JSON.stringify(l)).join("\n") + "\n{\"type\":\"assistant\",\"mess"; // a line still being written

describe("renderTranscript", () => {
  const md = renderTranscript(lines);

  test("the task, the agent's words, and herdr-core messages, with times", () => {
    expect(md).toContain("### Task given · 10:00");
    expect(md).toContain("> Task: DM-1 Form");
    expect(md).toContain("… (2 more lines)"); // a long brief is shortened
    expect(md).toContain("**Claude** · 10:01\n\nI'll look at the code first.");
    expect(md).toContain("### Message from herdr-core · 10:04");
    expect(md).toContain("Done; reporting.");
  });

  test("tool calls in plain words, with short results; errors marked", () => {
    expect(md).toContain("- Ran: List source files");
    expect(md).toContain("  ```sh\n  ls src\n  ```");
    expect(md).toContain("  app.ts\n  form.ts");
    expect(md).toContain("- Edited `/w/src/form.ts`");
    expect(md).toContain("- ✗ Ran a command");
    expect(md).toContain("fail 11\n  … (18 more lines)");
  });

  test("leaves out thinking, bookkeeping, subagents' inner turns and half-written lines", () => {
    expect(md).not.toContain("secret");
    expect(md).not.toContain("inner turn");
    expect(md).not.toContain('"mode"');
  });
});

describe("hcoord log", () => {
  let home: string;
  let repo: string;
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  test("finds a task's transcript by its session and adds its reports", async () => {
    home = tempDir("home");
    repo = tempRepo("app");
    const claudeDir = join(home, "claude");
    mkdirSync(join(claudeDir, "projects", "-some-worktree"), { recursive: true });
    writeFileSync(join(claudeDir, "projects", "-some-worktree", `${SESSION}.jsonl`), lines);
    const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeDir };
    expect(findTranscript(SESSION, join(claudeDir, "projects"))).toBe(join(claudeDir, "projects", "-some-worktree", `${SESSION}.jsonl`));
    expect(findTranscript("not-a-uuid", join(claudeDir, "projects"))).toBeNull();

    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, agent: { kind: "generic", command: ["true"] } }));
    await cli(home, ["project", "new", "demo", "--repo", repo, "--prefix", "DM"], undefined, env);
    await cli(home, ["task", "add", "--title", "Form", "--brief", "b"], undefined, env);
    // As launch would have recorded it.
    const file = join(home, "projects", "demo", "tasks.json");
    const tf = JSON.parse(readFileSync(file, "utf8"));
    tf.tasks[0].session = SESSION;
    writeFileSync(file, JSON.stringify(tf));
    mkdirSync(join(home, "projects", "demo", "reports"), { recursive: true });
    writeFileSync(join(home, "projects", "demo", "reports", "DM-1.md"), "## done · x\n\nMade the form.\n");

    const r = await cli(home, ["log", "DM-1"], undefined, env);
    expect(r.code).toBe(0);
    expect(r.stdout).toStartWith("# DM-1 Form (todo)\n");
    expect(r.stdout).toContain("- Edited `/w/src/form.ts`");
    expect(r.stdout).toContain("## Reports\n\n### done · x\n\nMade the form.");
    const j = JSON.parse((await cli(home, ["log", "dm-1", "--json"], undefined, env)).stdout);
    expect(j.transcript).toContain(`${SESSION}.jsonl`);

    // A worktree with no coordinator yet: says so instead of failing.
    const c = await cli(home, ["log", "--lane", "root"], undefined, env);
    expect(c.stdout).toContain("_No transcript: only Claude agents started by hcoord keep one._");
  });
});
