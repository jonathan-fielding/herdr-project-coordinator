/**
 * A coordinator after a reboot: its terminal comes back as a shell (hc keep), the same name and
 * address. A program killed by a signal takes the same road as a reboot, without the core's longer
 * grace delay, so these tests lose their coordinators with SIGKILL, on a private core.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HcTerminal } from "../src/hc.ts";
import { classifyCoordinator } from "../src/workers.ts";
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
      expect(r.stdout).toContain("`sleep 300` is running");
      expect(r.stdout).toContain(`hc attach ${address}`);
      expect(get(address).state).toBe("live");
      expect(get(address).foreground.argv).toEqual(["sleep", "300"]);
    }
    expect(starts()).toHaveLength(1);
    expect(record().address).toBe(address);

    core.hc("keys", address, "ctrl+c");
    await until("back at the shell", () => get(address).foreground?.pid === get(address).pid);
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

  test("occupied: a Claude started by hand isn't the coordinator; reported, left alone", async () => {
    const { address } = await started();
    await occupied(address);
    const r = await recover();
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("is running\n");
    expect(r.stdout).toContain("`sleep 300` is running");
    expect(r.stdout).toContain("Exit it");
    expect(get(address).foreground.argv).toEqual(["sleep", "300"]);
    expect(starts()).toHaveLength(1);
  }, 30_000);

  test("prompt: replaced, as it always was", async () => {
    writeFileSync(`${log}.silent`, "");
    await hcoord("project", "new", "demo", "--repo", repo, "--prefix", "DM");
    expect((await open()).code).toBe(0);
    const { address } = record();
    await until("our program running", () => get(address).foreground?.argv[0] === "sleep");
    const r = await recover();
    expect(r.code).toBe(0);
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
