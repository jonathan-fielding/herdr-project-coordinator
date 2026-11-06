/**
 * A coordinator after a reboot: its terminal comes back as a shell (hc keep), the same name and
 * address. A program killed by a signal takes the same road as a reboot, without the core's longer
 * grace delay, so these tests lose their coordinators with SIGKILL, on a private core.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HcTerminal } from "../src/hc.ts";
import { classifyCoordinator, foregroundProgram } from "../src/workers.ts";
import { TestCore } from "./hccore.ts";
import { cli, tempDir, tempRepo } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fixtures", "fake-claude.sh");
const NAME = "coord-dm-root";

describe("classifyCoordinator", () => {
  const OURS = ["env", "-u", "CLAUDE_CODE_CHILD_SESSION", "HCOORD_PROJECT=demo", "HCOORD_LANE=root", "claude", "--name", NAME];
  const SHELL = ["/bin/fish", "-l"];
  const term = (o: Partial<HcTerminal>): HcTerminal => ({ address: "t1", name: NAME, state: "live", keep: true, pid: 10, ...o });
  const idleShell = { argv: SHELL, pid: 10, foreground: { argv: SHELL, pid: 10 } };
  const classify = (o: Partial<HcTerminal>, claude = true) => classifyCoordinator(term(o), "demo", claude);

  test("no terminal, or a finished one", () => {
    expect(classifyCoordinator(null, "demo", true)).toBe("none");
    expect(classify({ state: "finished", argv: OURS })).toBe("none");
  });

  test("our program: running with a status, prompt without; a tool in its foreground changes nothing", () => {
    const tool = { argv: ["git", "status"], pid: 20 };
    expect(classify({ argv: OURS, status: "idle", foreground: tool })).toBe("running");
    expect(classify({ argv: OURS, status: null })).toBe("prompt");
    expect(classify({ argv: OURS, status: null }, false)).toBe("running");
  });

  test("replaced by any shell, idle: shell, even with a status left from what ran there", () => {
    expect(classify(idleShell)).toBe("shell");
    expect(classify({ ...idleShell, status: "idle" })).toBe("shell");
  });

  test("program lost, shell not started yet: shell, its argv still ours", () => {
    expect(classify({ argv: OURS, pid: null, foreground: null, reason: "stopped_by_restart" })).toBe("shell");
  });

  test("replaced, something else in the foreground: occupied, status or not", () => {
    const fg = { argv: ["claude"], pid: 20 };
    expect(classify({ argv: SHELL, foreground: fg, status: "idle" })).toBe("occupied");
    expect(classify({ argv: SHELL, foreground: fg })).toBe("occupied");
    // `exec claude` in the shell: the same pid, another program.
    expect(classify({ argv: SHELL, foreground: { argv: ["claude"], pid: 10 } })).toBe("occupied");
    // A shell inside the shell: the same argv, another pid.
    expect(classify({ argv: SHELL, foreground: { argv: SHELL, pid: 20 } })).toBe("occupied");
  });

  test("replaced, foreground unknown: occupied, so nothing is stopped on a guess", () => {
    expect(classify({ argv: SHELL, foreground: null })).toBe("occupied");
  });

  test("another project's env isn't ours", () => {
    expect(classify({ argv: ["env", "HCOORD_PROJECT=other", "claude"], foreground: { argv: ["claude"], pid: 10 } })).toBe("occupied");
  });

  test("not kept, or a core too old to give argv: only the status to go on", () => {
    expect(classify({ argv: ["sleep", "300"], keep: false, status: "idle" })).toBe("running");
    expect(classify({ argv: ["sleep", "300"], keep: false })).toBe("prompt");
    expect(classifyCoordinator({ address: "t1", state: "live", status: "idle" }, "demo", true)).toBe("running");
    expect(classifyCoordinator({ address: "t1", state: "live" }, "demo", true)).toBe("prompt");
  });
});

describe("foregroundProgram", () => {
  const term = (argv: string[] | null, status?: unknown) =>
    ({ address: "t1", state: "live", status, foreground: argv && { argv, pid: 20, name: "2.1.318" } }) as HcTerminal;
  const claudeCode = { app: "claude-code", state: "idle" };

  test("argv[0]'s basename, bare or a full path; never foreground.name", () => {
    expect(foregroundProgram(term(["claude"]))).toBe("claude");
    expect(foregroundProgram(term(["/Users/me/.local/bin/claude", "--resume"]))).toBe("claude");
    expect(foregroundProgram(term(["vim", "notes.md"]))).toBe("vim");
    expect(foregroundProgram(term(["/usr/bin/vim"]))).toBe("vim");
  });

  test("status.app decides only where argv can't", () => {
    expect(foregroundProgram(term(["node", "/opt/lib/cli.js"], claudeCode))).toBe("claude");
    expect(foregroundProgram(term(["/Users/me/.local/share/claude/versions/2.1.318"], claudeCode))).toBe("claude");
    expect(foregroundProgram(term(["node", "server.js"]))).toBe("node");
    expect(foregroundProgram(term(["node", "server.js"], { app: "other", state: "idle" }))).toBe("node");
    // Left there by a Claude that has since exited.
    expect(foregroundProgram(term(["vim"], claudeCode))).toBe("vim");
  });

  test("nothing known: null, status or not", () => {
    expect(foregroundProgram(null)).toBeNull();
    expect(foregroundProgram(term(null, claudeCode))).toBeNull();
    expect(foregroundProgram(term([]))).toBeNull();
  });
});

const core = new TestCore();
// Not hardcoded to anyone's shell: a replaced coordinator is whatever $SHELL the core was started with.
core.env.SHELL = "/bin/sh";
beforeAll(() => core.start());
afterAll(() => core.stop());

let home: string, repo: string, claudeDir: string, log: string, env: Record<string, string | undefined>;

beforeEach(() => {
  home = tempDir("home");
  repo = tempRepo("app");
  claudeDir = tempDir("claude");
  log = join(home, "started.log");
  env = { ...core.env, CLAUDE_CONFIG_DIR: claudeDir, HCOORD_CLAUDE_JSON: join(claudeDir, "none.json") };
  const r = Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  writeFileSync(join(home, "config.json"), JSON.stringify({
    version: 1, agent: { kind: "claude", command: ["/bin/sh", FAKE, log] }, worktreeRoot: join(home, "wt"),
  }));
});

afterEach(() => {
  for (const t of core.hc("ls").terminals ?? []) core.hc("kill", t.address);
  for (const d of [home, repo, claudeDir]) rmSync(d, { recursive: true, force: true });
});

const hcoord = (...args: string[]) => cli(home, args, undefined, env);
const open = (...flags: string[]) => hcoord("lane", "open", repo, "--no-show", ...flags);
const get = (t: string) => core.hc("get", t);
const record = () => JSON.parse(readFileSync(join(home, "projects", "demo", "project.json"), "utf8")).lanes.root.coordinator;
const starts = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
/** The arguments of the agent's nth start, once it has got that far. */
async function startLine(n: number): Promise<string> {
  await until(`start ${n}`, () => starts().length >= n);
  return starts()[n - 1]!;
}
const flagOf = (line: string, flag: string) => line.match(new RegExp(`${flag} (\\S+)`))?.[1];

async function until(what: string, check: () => boolean, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (check()) return;
  throw new Error(`timed out: ${what}`);
}

/** The project with a coordinator, up and reporting a status. */
async function started(): Promise<{ address: string; session: string }> {
  const r = await hcoord("project", "new", "demo", "--repo", repo, "--prefix", "DM");
  if (r.code !== 0) throw new Error(r.stdout + r.stderr);
  const o = await open();
  if (o.code !== 0) throw new Error(o.stdout + o.stderr);
  const { address, session } = record();
  await until("its status", () => !!get(address).status);
  return { address, session };
}

const transcript = (session: string) => {
  mkdirSync(join(claudeDir, "projects", "app"), { recursive: true });
  writeFileSync(join(claudeDir, "projects", "app", `${session}.jsonl`), "{}\n");
};

/** What a reboot leaves: the program gone, the core yet to start the shell. */
const lose = (address: string) => {
  process.kill(get(address).pid, "SIGKILL");
  return until("the program lost", () => get(address).pid === null || get(address).argv[0] === "/bin/sh");
};

/** What the person sees after a reboot: a shell at its prompt. */
async function replaced(address: string) {
  await lose(address);
  await until("the idle shell", () => {
    const t = get(address);
    return t.foreground?.pid === t.pid && t.argv[0] === "/bin/sh";
  });
}

/** A Claude started by hand in the shell: it runs in the foreground and reports a status. */
async function occupied(address: string) {
  await replaced(address);
  core.hc("send", address, `printf '\\033]7501;state=idle\\007'; sleep 300`);
  await until("something in the foreground", () => get(address).foreground?.argv[0] === "sleep" && !!get(address).status);
}

/** A stand-in for a Claude started by hand: `sleep` under the name `claude`. Bare: found on PATH, as typed by hand. */
async function plainClaude(address: string, how: "bare" | "full path") {
  await replaced(address);
  const bin = join(home, "bin");
  mkdirSync(bin);
  symlinkSync("/bin/sleep", join(bin, "claude"));
  core.hc("send", address, how === "bare" ? `PATH="${bin}:$PATH" claude 300` : `"${bin}/claude" 300`);
  await until("Claude in the foreground", () => get(address).foreground?.argv.at(-1) === "300" && get(address).foreground.argv[0].endsWith("claude"));
}

const laneOnBoard = async () => JSON.parse((await hcoord("board", "--json")).stdout).projects[0].lanes[0];
const stateOnBoard = async () => JSON.parse((await hcoord("board", "--json")).stdout).projects[0].lanes[0].coordinatorState;

describe("lane open", () => {
  test("shell: resumes the saved session in a new terminal, no flag needed", async () => {
    const { address, session } = await started();
    transcript(session);
    await replaced(address);
    expect(await stateOnBoard()).toBe("shell");

    const r = await open();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`stopped ${NAME} (${address}): only a shell now`);
    expect(r.stdout).toContain(`resumed coordinator ${NAME}`);
    expect(get(address).state).toBe("finished");
    expect(record().address).not.toBe(address);
    expect(record().session).toBe(session);
    expect(flagOf(await startLine(2), "--resume")).toBe(session);
    await until("running again", () => !!get(record().address).status);
    expect(await stateOnBoard()).toBe("running");
  }, 30_000);

  test("shell not started yet: the same, right after the program was lost", async () => {
    const { address, session } = await started();
    transcript(session);
    process.kill(get(address).pid, "SIGKILL");
    await until("the program lost", () => get(address).pid === null);
    const r = await open();
    expect(r.code).toBe(0);
    expect(flagOf(await startLine(2), "--resume")).toBe(session);
    // No shell turns up later in the closed terminal.
    await Bun.sleep(2500);
    expect(get(address).state).toBe("finished");
  }, 30_000);

  test("shell, the transcript gone: a new session", async () => {
    const { address, session } = await started();
    await replaced(address);
    const r = await open();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`started coordinator ${NAME}`);
    const line = await startLine(2);
    expect(line).not.toContain("--resume");
    expect(flagOf(line, "--session-id")).toBe(record().session);
    expect(record().session).not.toBe(session);
  }, 30_000);

  test("shell with --fresh: a new session, though the transcript is there", async () => {
    const { address, session } = await started();
    transcript(session);
    await replaced(address);
    expect((await open("--fresh")).code).toBe(0);
    expect(await startLine(2)).not.toContain("--resume");
    expect(record().session).not.toBe(session);
  }, 30_000);

  test("occupied: never stopped, with or without --restart; once exited, it resumes", async () => {
    const { address, session } = await started();
    transcript(session);
    await occupied(address);
    expect(await stateOnBoard()).toBe("occupied");

    for (const flags of [[], ["--restart"]]) {
      const r = await open(...flags);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain(`\`sleep 300\` is running in ${NAME} (${address}), not the coordinator`);
      expect(r.stdout).toContain(`hc attach ${address}`);
      expect(get(address).state).toBe("live");
      expect(get(address).foreground.argv).toEqual(["sleep", "300"]);
    }
    expect(starts()).toHaveLength(1);
    expect(record().address).toBe(address);
    expect(await laneOnBoard()).toMatchObject({ coordinatorState: "occupied", coordinatorProgram: "sleep" });

    core.hc("keys", address, "ctrl+c");
    await until("back at the shell", () => get(address).foreground?.pid === get(address).pid);
    expect(await laneOnBoard()).toMatchObject({ coordinatorState: "shell", coordinatorProgram: null });
    expect((await open()).code).toBe(0);
    expect(flagOf(await startLine(2), "--resume")).toBe(session);
  }, 30_000);

  test("prompt: says to look, and --restart replaces it, resuming", async () => {
    writeFileSync(`${log}.silent`, "");
    await hcoord("project", "new", "demo", "--repo", repo, "--prefix", "DM");
    expect((await open()).code).toBe(0);
    const { address, session } = record();
    transcript(session);
    await until("our program running", () => get(address).foreground?.argv[0] === "sleep");
    expect(await stateOnBoard()).toBe("prompt");

    const r = await open();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("reports no agent status");
    expect(r.stdout).toContain(`hc attach ${address}`);
    expect(r.stdout).toContain("--restart");
    expect(get(address).state).toBe("live");

    const again = await open("--restart");
    expect(again.code).toBe(0);
    expect(again.stdout).toContain(`stopped ${NAME} (${address}): reporting no agent status`);
    expect(get(address).state).toBe("finished");
    expect(flagOf(await startLine(2), "--resume")).toBe(session);
  }, 30_000);

  test("prompt with --restart, the transcript gone: a new session", async () => {
    writeFileSync(`${log}.silent`, "");
    await hcoord("project", "new", "demo", "--repo", repo, "--prefix", "DM");
    expect((await open()).code).toBe(0);
    const { session } = record();
    await until("our program running", () => get(record().address).foreground?.argv[0] === "sleep");
    expect((await open("--restart")).code).toBe(0);
    expect(await startLine(2)).not.toContain("--resume");
    expect(record().session).not.toBe(session);
  }, 30_000);

  test("running: left alone, with or without --restart", async () => {
    const { address } = await started();
    expect(await stateOnBoard()).toBe("running");
    for (const flags of [[], ["--restart"]]) {
      const r = await open(...flags);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("is already running");
    }
    expect(get(address).state).toBe("live");
    expect(starts()).toHaveLength(1);
  }, 30_000);

  for (const how of ["bare", "full path"] as const) {
    test(`occupied by a plain Claude, ${how}: the board says so and the refusal says how to get back`, async () => {
      const { address, session } = await started();
      transcript(session);
      await plainClaude(address, how);
      expect(await laneOnBoard()).toMatchObject({ coordinatorState: "occupied", coordinatorProgram: "claude" });

      const saved = await open();
      expect(saved.code).toBe(1);
      expect(saved.stdout).toContain(`A plain Claude, started by hand, is running in ${NAME} (${address}), not the coordinator`);
      expect(saved.stdout).toContain(`/exit it (see it with: hc attach ${address})`);
      expect(saved.stdout).toContain("saved conversation comes back, not this session");

      rmSync(join(claudeDir, "projects"), { recursive: true });
      const unsaved = await open();
      expect(unsaved.code).toBe(1);
      expect(unsaved.stdout).toContain("That starts a new conversation");
      expect(unsaved.stdout).not.toContain("saved conversation");
      expect(get(address).state).toBe("live");
      expect(starts()).toHaveLength(1);
    }, 30_000);
  }

  test("its record lost: an earlier coordinator that's a shell is replaced, an occupied one is refused", async () => {
    const { address } = await started();
    const file = join(home, "projects", "demo", "project.json");
    const forget = () => {
      const m = JSON.parse(readFileSync(file, "utf8"));
      delete m.lanes.root.coordinator;
      writeFileSync(file, JSON.stringify(m));
    };
    await occupied(address);
    forget();
    expect(await stateOnBoard()).toBe("none");
    const r = await open("--restart");
    expect(r.code).toBe(1);
    expect(get(address).state).toBe("live");

    core.hc("keys", address, "ctrl+c");
    await until("back at the shell", () => get(address).foreground?.pid === get(address).pid);
    const again = await open();
    expect(again.code).toBe(0);
    expect(again.stdout).toContain(`stopped ${NAME} (${address}): an earlier coordinator of this worktree, only a shell now`);
    expect(again.stdout).toContain(`started coordinator ${NAME}`);
  }, 30_000);
});

describe("lane say", () => {
  test("a shell is resumed first; nothing is typed into it", async () => {
    const { address, session } = await started();
    transcript(session);
    await replaced(address);
    const r = await hcoord("lane", "say", repo, "--no-show", "hello");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`resumed coordinator ${NAME}`);
    expect(r.stdout).toContain(`sent to ${NAME} (${record().address})`);
  }, 30_000);

  test("occupied: nothing is sent to what runs there", async () => {
    const { address } = await started();
    await occupied(address);
    const r = await hcoord("lane", "say", repo, "--no-show", "NOT-FOR-YOU");
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("sent to");
    expect(JSON.stringify(core.hc("read", address))).not.toContain("NOT-FOR-YOU");
  }, 30_000);
});

describe("worker notes", () => {
  const NOTE = "DM-1 needs_you";
  const screen = (t: string) => JSON.stringify(core.hc("read", t));

  /** A coordinator, up, with DM-1 working under `parent` (default: that coordinator). */
  async function withWorker(parent?: string): Promise<{ address: string; session: string; worker: string }> {
    const c = await started();
    await hcoord("task", "add", "demo", "--title", "Work", "--brief", "b");
    const r = await hcoord("task", "start", "DM-1", ...(parent ? ["--parent", parent] : []));
    if (r.code !== 0) throw new Error(r.stdout + r.stderr);
    return { ...c, worker: taskOne().terminal.address };
  }
  const taskOne = () => JSON.parse(readFileSync(join(home, "projects", "demo", "tasks.json"), "utf8")).tasks[0];
  /** Both ways a note goes out: the Stop hook, then a report. Returns what the report printed. */
  async function sendNotes(worker: string): Promise<string> {
    const stopped = await cli(home, ["worker-stopped", "DM-1"], undefined, { ...env, HC_TERMINAL_ID: worker });
    expect(stopped.code).toBe(0);
    const r = await cli(home, ["report", "DM-1", "--state", "needs_you", "--file", "-"], "A question.", env);
    expect(r.code).toBe(0);
    expect(taskOne().state).toBe("needs_you");
    return r.stdout;
  }

  test("running: the coordinator gets them", async () => {
    const { address, worker } = await withWorker();
    expect(await stateOnBoard()).toBe("running");
    expect(await sendNotes(worker)).toContain(`notified the coordinator (${address})`);
    await until("the notes in its terminal", () => screen(address).includes(NOTE));
  }, 30_000);

  test("shell: nothing is typed, the state is saved, and the resumed coordinator gets the next note", async () => {
    const { address, session, worker } = await withWorker();
    transcript(session);
    await replaced(address);
    expect(await sendNotes(worker)).toContain("no coordinator terminal to notify");
    await Bun.sleep(300);
    expect(screen(address)).not.toContain(NOTE);

    expect((await open()).code).toBe(0);
    const again = await cli(home, ["report", "DM-1", "--state", "needs_you", "--file", "-"], "Another.", env);
    expect(again.stdout).toContain(`notified the coordinator (${record().address})`);
  }, 30_000);

  test("occupied: nothing reaches what runs there", async () => {
    const { address, worker } = await withWorker();
    await occupied(address);
    expect(await stateOnBoard()).toBe("occupied");
    expect(await sendNotes(worker)).toContain("no coordinator terminal to notify");
    await Bun.sleep(300);
    expect(screen(address)).not.toContain(NOTE);
  }, 30_000);

  for (const [name, replace] of [["shell", replaced], ["occupied", occupied]] as const) {
    test(`--parent another live terminal, the coordinator ${name}: that terminal gets them`, async () => {
      const boss = core.hc("run", "--bg", "--no-parent", "--outlive-parent", "--name", "boss", "--", "sleep", "300").address;
      const { address, worker } = await withWorker(boss);
      await replace(address);
      expect(await sendNotes(worker)).toContain(`notified the coordinator (${boss})`);
      await until("the notes in its terminal", () => screen(boss).includes(NOTE));
      expect(screen(address)).not.toContain(NOTE);
    }, 30_000);
  }

  test("a task started while the coordinator is a shell doesn't report to that shell", async () => {
    const { address } = await started();
    await replaced(address);
    await hcoord("task", "add", "demo", "--title", "Work", "--brief", "b");
    expect((await hcoord("task", "start", "DM-1")).stdout).toContain(", no coordinator");
    expect(taskOne().parent).toBeUndefined();
  }, 30_000);
});

describe("recover", () => {
  const recover = () => hcoord("recover", "demo", "--no-show");

  test("shell: restarted, resuming", async () => {
    const { address, session } = await started();
    transcript(session);
    await replaced(address);
    const r = await recover();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`resumed coordinator ${NAME}`);
    expect(get(address).state).toBe("finished");
    expect(flagOf(await startLine(2), "--resume")).toBe(session);
  }, 30_000);

  test("shell, the transcript gone: restarted in a new session", async () => {
    const { address, session } = await started();
    await replaced(address);
    const r = await recover();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`started coordinator ${NAME}`);
    expect(record().session).not.toBe(session);
  }, 30_000);

  test("occupied by a plain Claude: recover says what it is and how to get back", async () => {
    const { address } = await started();
    await plainClaude(address, "bare");
    const r = await recover();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("A plain Claude, started by hand, is running in");
    expect(r.stdout).toContain("/exit it");
    expect(starts()).toHaveLength(1);
  }, 30_000);

  test("occupied: a Claude started by hand isn't the coordinator; reported, left alone", async () => {
    const { address } = await started();
    await occupied(address);
    const r = await recover();
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("is running\n");
    expect(r.stdout).toContain("`sleep 300` is running in");
    expect(r.stdout).toContain("Exit it");
    expect(get(address).foreground.argv).toEqual(["sleep", "300"]);
    expect(starts()).toHaveLength(1);
  }, 30_000);

  test("prompt: reported and left alone, however often it's run; lane open --restart still replaces it", async () => {
    writeFileSync(`${log}.silent`, "");
    await hcoord("project", "new", "demo", "--repo", repo, "--prefix", "DM");
    expect((await open()).code).toBe(0);
    const { address } = record();
    await until("our program running", () => get(address).foreground?.argv[0] === "sleep");
    for (let i = 0; i < 2; i++) {
      const r = await recover();
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("reports no agent status");
      expect(r.stdout).toContain(`hc attach ${address}`);
      expect(get(address).state).toBe("live");
      expect(record().address).toBe(address);
    }
    expect(starts()).toHaveLength(1);

    expect((await open("--restart")).code).toBe(0);
    expect(get(address).state).toBe("finished");
    expect(await startLine(2)).toContain("--session-id");
  }, 30_000);

  test("running: left alone", async () => {
    const { address } = await started();
    const r = await recover();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`root: coordinator ${NAME} (${address}) is running`);
    expect(starts()).toHaveLength(1);
  }, 30_000);
});

describe("hc kill on a kept terminal", () => {
  const run = (...argv: string[]) => core.hc("run", "--bg", "--no-parent", "--outlive-parent", "--keep", "--name", "kept", "--", ...argv).address as string;
  const shell = () => run("/bin/sh", "-c", `trap '' HUP TERM; while :; do sleep 1; done`);

  test("ends it and frees its name by the time it returns, even a program that ignores hangups", () => {
    const stubborn = shell();
    Bun.sleepSync(200);
    core.hc("kill", stubborn);
    expect(get(stubborn).state).toBe("finished");
    expect(get(stubborn).reason).toBe("killed");

    for (let i = 0; i < 5; i++) {
      const t = run("sleep", "300");
      core.hc("kill", t);
      expect(get(t).state).toBe("finished");
    }
    const last = run("sleep", "300");
    // The name means the live terminal, not the finished ones before it.
    expect(get("kept").address).toBe(last);
    core.hc("kill", last);
  }, 30_000);

  test("stays closed: it isn't replaced by a shell", async () => {
    const t = run("sleep", "300");
    core.hc("kill", t);
    await Bun.sleep(2500);
    expect(get(t).state).toBe("finished");
    expect(existsSync(log)).toBe(false);
  }, 30_000);
});
