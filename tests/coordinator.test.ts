/** project open, worker-stopped and memory, against a private herdr-core with stand-in agents. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../src/model.ts";
import { TestCore } from "./hccore.ts";
import { CLI, cli, tempDir, tempRepo } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fixtures", "fake-worker.sh");
const core = new TestCore();
beforeAll(() => core.start());
afterAll(() => core.stop());

let home: string;
let repo: string;

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

/** The stand-in coordinator appends whatever is typed into it to <home>/inbox.txt. */
function setup() {
  home = tempDir("home");
  repo = tempRepo("app");
  writeFileSync(join(repo, "README.md"), "app\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  const coordinatorCmd = ["sh", "-c", `cat >> '${join(home, "inbox.txt")}'`];
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      version: 1,
      agent: { kind: "generic", command: ["sh", FAKE], coordinatorArgs: [] },
      worktreeRoot: join(home, "wt"),
      maxParallel: 3,
    }),
  );
  return coordinatorCmd;
}

afterEach(() => {
  for (const t of core.hc("ls", "--label", "hcoord.project=demo").terminals ?? []) core.hc("kill", t.address);
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

const hcoord = (...args: string[]) => cli(home, args, undefined, core.env);
const ok = async (...args: string[]) => {
  const r = await hcoord(...args);
  if (r.code !== 0) throw new Error(`hcoord ${args.join(" ")} → ${r.code}:\n${r.stdout}${r.stderr}`);
  return r.stdout;
};
const tasks = (): Task[] => JSON.parse(readFileSync(join(home, "projects", "demo", "tasks.json"), "utf8")).tasks;
const meta = () => JSON.parse(readFileSync(join(home, "projects", "demo", "project.json"), "utf8"));
const inbox = () => (existsSync(join(home, "inbox.txt")) ? readFileSync(join(home, "inbox.txt"), "utf8") : "");

async function until(what: string, pred: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(100);
  }
}

describe("project open", () => {
  test("starts a kept, parentless coordinator once; workers then report to it by default", async () => {
    const coordinatorCmd = setup();
    await ok("project", "new", "demo", "--repo", repo, "--prefix", "DM");
    // A generic coordinator runs `command + coordinatorArgs + prompt`; make it the inbox stand-in.
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ ...cfg, agent: { ...cfg.agent, command: coordinatorCmd } }));

    const out = await ok("project", "open", "demo", "--no-show");
    expect(out).toContain("started coordinator coord-dm-root");
    const c = meta().lanes.root.coordinator;
    expect(c.name).toBe("coord-dm-root");
    const h = core.hc("get", c.address);
    // It runs in the main checkout (the "root" worktree), kept, with no parent.
    expect(h).toMatchObject({ state: "live", keep: true, parent: null, cwd: repo });
    expect(h.labels).toMatchObject({ "hcoord.project": "demo", "hcoord.lane": "root", "hcoord.role": "coordinator" });
    expect(h.argv.slice(0, 5)).toEqual(["env", "-u", "CLAUDE_CODE_CHILD_SESSION", "HCOORD_PROJECT=demo", "HCOORD_LANE=root"]);
    // Exactly what hcoord built: nothing of hc's own (like --json) leaked onto the end.
    expect(h.argv.at(-1)).toBe("You coordinate hcoord project demo, worktree root.");

    expect(await ok("project", "open", "demo", "--no-show")).toContain(`coordinator coord-dm-root (${c.address}) is already running`);
    expect(core.hc("ls", "--label", "hcoord.role=coordinator").terminals).toHaveLength(1);

    // Back to the fake worker; no --parent: the project's coordinator is used.
    writeFileSync(join(home, "config.json"), JSON.stringify(cfg));
    const brief = ["Do it.", `BUN=${process.execPath}`, `CLI=${CLI}`, `HCOORD_HOME=${home}`].join("\n");
    await ok("task", "add", "--title", "Job", "--brief", brief);
    expect(await ok("task", "start", "DM-1")).toContain(`reporting to ${c.address}`);
    expect(core.hc("get", tasks()[0]!.terminal!.address).parent).toBe(c.address);
    await until("DM-1 merged", () => tasks()[0]!.state === "merged");
    await until("the report in the coordinator", () => inbox().includes("DM-1 done (merged into"));
  }, 60_000);
});

describe("worker-stopped (the Claude Stop hook)", () => {
  test("a working task whose worker stopped without reporting becomes needs_you, once", async () => {
    setup();
    await ok("project", "new", "demo", "--repo", repo, "--prefix", "DM");
    const parent = core.hc("run", "--bg", "--name", "coord-x", "--", "sh", "-c", `cat >> '${join(home, "inbox.txt")}'`).address;
    await ok("task", "add", "--title", "Quiet", "--brief", `GATE=${join(home, "never")}`);
    await ok("task", "start", "DM-1", "--parent", parent);
    const worker = tasks()[0]!.terminal!.address;

    // Run as the hook would: from the worker's terminal (HC_TERMINAL_ID = the worker).
    const asWorker = { ...core.env, HC_TERMINAL_ID: worker };
    expect((await cli(home, ["worker-stopped", "DM-1"], undefined, asWorker)).code).toBe(0);
    expect(tasks()[0]).toMatchObject({ state: "needs_you", needsYouAuto: true });
    expect(tasks()[0]!.needsYouReason).toContain(`worker ended its turn without reporting; hc read ${worker}`);
    await until("the note in the coordinator", () => inbox().includes("DM-1 needs_you: worker ended its turn without reporting"));

    // Again (or from another terminal, or for a task that isn't working): nothing happens.
    const lines = readFileSync(join(home, "projects", "demo", "events.log"), "utf8").split("\n").length;
    await cli(home, ["worker-stopped", "DM-1"], undefined, asWorker);
    await cli(home, ["worker-stopped", "NOPE-1"], undefined, asWorker);
    expect(readFileSync(join(home, "projects", "demo", "events.log"), "utf8").split("\n").length).toBe(lines);

    // A reply resumes it.
    expect(await ok("task", "reply", "DM-1", "carry on")).toContain("DM-1 → working");
    core.hc("kill", parent);
  }, 60_000);
});

describe("Claude folder trust", () => {
  /** kind "claude" (so hcoord adds Claude's flags) but the fake worker as the program. */
  function claudeKind(trusted: boolean) {
    setup();
    const cfg = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ ...cfg, agent: { kind: "claude", command: ["sh", FAKE] } }));
    const claudeJson = join(home, "claude.json");
    writeFileSync(claudeJson, JSON.stringify({ projects: trusted ? { [repo]: { hasTrustDialogAccepted: true } } : {} }));
    return { ...core.env, HCOORD_CLAUDE_JSON: claudeJson };
  }

  test("task start refuses a repo Claude doesn't trust, before touching anything", async () => {
    const env = claudeKind(false);
    const created = await cli(home, ["project", "new", "demo", "--repo", repo, "--prefix", "DM"], undefined, env);
    expect(created.stderr).toContain(`hasn't been told to trust ${repo}`);
    await cli(home, ["task", "add", "--title", "T", "--brief", "b"], undefined, env);
    const r = await cli(home, ["task", "start", "DM-1"], undefined, env);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Run \`claude\` in ${repo} once`);
    expect(tasks()[0]!.state).toBe("todo");
    expect(existsSync(join(home, "wt"))).toBe(false);
  }, 30_000);

  test("a worker that sits silently at a trust prompt is flagged needs_you right after launch", async () => {
    const env = claudeKind(true);
    await cli(home, ["project", "new", "demo", "--repo", repo, "--prefix", "DM"], undefined, env);
    const brief = ["Do it.", "MODE=trustprompt"].join("\n");
    await cli(home, ["task", "add", "--title", "T", "--brief", brief], undefined, env);
    const r = await cli(home, ["task", "start", "DM-1"], undefined, env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("started DM-1");
    expect(r.stdout).toContain(`DM-1 → needs_you: worker is stuck at Claude's "trust this folder?" prompt`);
    expect(tasks()[0]).toMatchObject({ state: "needs_you", needsYouAuto: true });
    // The worker got Claude's flags with the brief last.
    const argv = core.hc("get", tasks()[0]!.terminal!.address).argv as string[];
    expect(argv).toContain("--settings");
    expect(argv.at(-1)).toContain("Task: DM-1 T");
  }, 30_000);
});

describe("memory", () => {
  test("appends dated notes, with or without a project name", async () => {
    setup();
    await ok("project", "new", "demo", "--repo", repo, "--prefix", "DM");
    await ok("memory", "The person prefers small PRs.");
    await ok("memory", "demo", "Tests run with bun test.");
    await ok("memory", "dm", "Prefix works too.");
    const md = readFileSync(join(home, "projects", "demo", "MEMORY.md"), "utf8");
    expect(md).toMatch(/- \d{4}-\d\d-\d\d: The person prefers small PRs\.\n- \d{4}-\d\d-\d\d: Tests run with bun test\.\n- .*: Prefix works too\.\n$/);
    expect((await hcoord("memory")).code).toBe(2);
  }, 30_000);
});
