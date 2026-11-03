import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeTrusts, coordinatorArgv, PLUGIN_DIR, workerArgv } from "../src/agents.ts";
import { renderWorkerBrief } from "../src/brief.ts";
import { defaultConfig, type Config } from "../src/config.ts";
import type { Task } from "../src/model.ts";
import { tempDir } from "./helpers.ts";

const claude = (extra: Partial<Config["agent"]> = {}): Config => ({
  ...defaultConfig(),
  agent: { kind: "claude", command: ["claude"], ...extra },
});

describe("agent argv", () => {
  test("Claude worker: env, report allowed, Stop hook, name, prompt last", () => {
    const argv = workerArgv(claude({ workerArgs: ["--model", "sonnet"] }), "demo", "DM-3", "w-dm-3", "THE BRIEF");
    expect(argv.slice(0, 4)).toEqual(["env", "-u", "CLAUDE_CODE_CHILD_SESSION", "HCOORD_PROJECT=demo"]);
    expect(argv.at(-1)).toBe("THE BRIEF");
    expect(argv.slice(-3, -1)).toEqual(["--model", "sonnet"]);
    // --allowedTools is variadic: the next argument must be another option, never the prompt.
    const i = argv.indexOf("--allowedTools");
    expect(argv[i + 1]).toBe("Bash(hcoord report *)");
    expect(argv[i + 2]!.startsWith("--")).toBe(true);
    const settings = JSON.parse(argv[argv.indexOf("--settings") + 1]!);
    const hook = settings.hooks.Stop[0].hooks[0].command as string;
    expect(hook).toMatch(/cli\.ts' worker-stopped DM-3$/);
    expect(argv[argv.indexOf("--name") + 1]).toBe("w-dm-3");
  });

  test("Claude coordinator: plugin, hcoord/hc allowed, skill invoked as the first message", () => {
    const argv = coordinatorArgv(claude(), "demo", "login", "coord-dm-login", "11111111-2222-3333-4444-555555555555");
    expect(argv.at(-1)).toBe("/hcoord:coordinator demo login");
    expect(argv).toContain("HCOORD_LANE=login");
    expect(argv[argv.indexOf("--session-id") + 1]).toBe("11111111-2222-3333-4444-555555555555");
    // Resuming after a reboot: the same session, carried on with a note instead of the skill.
    const again = coordinatorArgv(claude(), "demo", "login", "coord-dm-login", "11111111-2222-3333-4444-555555555555", true);
    expect(again[again.indexOf("--resume") + 1]).toBe("11111111-2222-3333-4444-555555555555");
    expect(again).not.toContain("--session-id");
    expect(again.at(-1)).toContain("You were restarted");
    expect(argv[argv.indexOf("--plugin-dir") + 1]).toBe(PLUGIN_DIR);
    const i = argv.indexOf("--allowedTools");
    expect(argv.slice(i + 1, i + 5)).toEqual(["Bash(hcoord *)", "Bash(hc ls *)", "Bash(hc get *)", "Bash(hc read *)"]);
    // Deleting and driving terminals are blocked outright; the variadic list ends at another option.
    const d = argv.indexOf("--disallowedTools");
    expect(d).toBe(i + 5);
    const denied = argv.slice(d + 1, argv.findIndex((a, k) => k > d && a.startsWith("--")));
    expect(denied).toContain("Bash(hcoord project delete *)");
    expect(denied).toContain("Bash(hcoord lane remove *)");
    expect(denied).toContain("Bash(hc kill *)");
    expect(denied).not.toContain("Bash(hcoord *)");
  });

  test("generic agents get the env prefix, their command and the prompt", () => {
    const cfg: Config = { ...defaultConfig(), agent: { kind: "generic", command: ["sh", "x.sh"] } };
    expect(workerArgv(cfg, "demo", "DM-1", "w-dm-1", "P").slice(4)).toEqual(["sh", "x.sh", "P"]);
  });

  test("codex says it isn't supported yet", () => {
    const cfg: Config = { ...defaultConfig(), agent: { kind: "codex", command: ["codex"] } };
    expect(() => workerArgv(cfg, "d", "D-1", "w", "p")).toThrow("isn't supported yet");
  });
});

describe("claudeTrusts", () => {
  let home: string;
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  test("trust belongs to the repo root; a trusted parent folder only makes it unknown", () => {
    home = tempDir("claudehome");
    const file = join(home, ".claude.json");
    expect(claudeTrusts("/x", file)).toBeNull(); // no ~/.claude.json
    writeFileSync(
      file,
      JSON.stringify({ projects: { [join(home, "app")]: { hasTrustDialogAccepted: true }, [join(home, "no")]: {} } }),
    );
    mkdirSync(join(home, "app", "nested"), { recursive: true });
    expect(claudeTrusts(join(home, "app"), file)).toBe(true);
    // A repo nested inside a trusted folder still prompts in Claude 2.1.316: we can't be sure.
    expect(claudeTrusts(join(home, "app", "nested"), file)).toBeNull();
    expect(claudeTrusts(join(home, "no"), file)).toBe(false);
    expect(claudeTrusts(join(home, "other"), file)).toBe(false);
  });
});

describe("worker brief", () => {
  const task: Task = {
    id: "DM-2", title: "API", brief: "Build it.\nYou own: api/.", state: "starting", repo: "/r", lane: "root",
    branch: "coord/root/dm-2-api", dependsOn: [], createdAt: "x", updatedAt: "x",
  };
  const meta = { version: 1 as const, slug: "demo", name: "Demo", prefix: "DM", repo: "/r", lanes: {}, createdAt: "x" };

  test("has the task, paths, rules, project notes and exact report commands", () => {
    const b = renderWorkerBrief({ meta, task, worktree: "/wt/dm-2", coordinator: "t9", projectNotes: "Run tests with bun test." });
    expect(b).toContain("Task: DM-2 API\n");
    expect(b).toContain("Worktree: /wt/dm-2\nBranch: coord/root/dm-2-api");
    expect(b).toContain("Coordinator terminal: t9");
    expect(b).toContain("Build it.\nYou own: api/.");
    expect(b).toContain("## Project notes (from PROJECT.md)\n\nRun tests with bun test.");
    expect(b).toContain("hcoord report DM-2 --state done --file - <<'REPORT'");
    expect(b).toContain("hcoord report DM-2 --state needs_you --file - <<'REPORT'");
    expect(b).toContain("Do not push, rebase");
    expect(b).toContain(`Merged into: worktree "root", by hcoord when you report done`);
  });

  test("leaves out the notes section when PROJECT.md says nothing", () => {
    expect(renderWorkerBrief({ meta, task, worktree: "/w", coordinator: null })).not.toContain("Project notes");
  });
});
