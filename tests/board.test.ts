/** hcoord board / sync / mod install, and mutations that change nothing writing nothing. */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, tempDir, tempRepo } from "./helpers.ts";

let home: string;
let repo: string;
let app: string;
afterEach(() => {
  for (const d of [home, repo, app]) if (d) rmSync(d, { recursive: true, force: true });
});

function setup() {
  home = tempDir("home");
  repo = tempRepo("app");
  // Generic agent: no Claude trust checks; nothing here starts a worker.
  writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, agent: { kind: "generic", command: ["true"] } }));
}
const ok = async (...args: string[]) => {
  const r = await cli(home, args);
  if (r.code !== 0) throw new Error(`hcoord ${args.join(" ")} → ${r.code}:\n${r.stdout}${r.stderr}`);
  return r.stdout;
};

describe("board", () => {
  test("every project with its tasks, waits and coordinator, read only", async () => {
    setup();
    await ok("project", "new", "demo", "--repo", repo, "--prefix", "DM");
    await ok("task", "add", "--title", "First", "--brief", "b");
    await ok("task", "add", "--title", "Second", "--brief", "b", "--depends-on", "DM-1");
    const tasksJson = join(home, "projects", "demo", "tasks.json");
    const before = statSync(tasksJson).mtimeMs;

    const b = JSON.parse(await ok("board", "--json"));
    expect(b).toMatchObject({ version: 2, root: home, agent: "generic" });
    // Tests run in a temp folder: the board says it isn't a safe place for data.
    expect(b.warnings).toEqual([expect.stringContaining("temporary folder")]);
    expect(b.projects).toHaveLength(1);
    const p = b.projects[0];
    expect(p).toMatchObject({ slug: "demo", prefix: "DM", repo, trusted: null });
    expect(p.lanes).toEqual([{ key: "root", path: repo, branch: p.checkouts[0].branch, present: true, coordinator: null, coordinatorState: "none", coordinatorProgram: null }]);
    expect(p.checkouts).toEqual([{ path: repo, branch: expect.any(String) }]);
    expect(p.tasks.map((t: any) => [t.id, t.state, t.lane, t.waitingOn, t.hasLog])).toEqual([
      ["DM-1", "todo", "root", [], false],
      ["DM-2", "todo", "root", ["DM-1"], false],
    ]);
    expect(statSync(tasksJson).mtimeMs).toBe(before);
    expect(await ok("board")).toMatch(/^demo\s+2 todo\n$/);
  });

  test("no projects", async () => {
    setup();
    expect(JSON.parse(await ok("board", "--json")).projects).toEqual([]);
  });

  test("Claude trust per repo", async () => {
    setup();
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, agent: { kind: "claude", command: ["claude"] } }));
    const claudeJson = join(home, "claude.json");
    writeFileSync(claudeJson, JSON.stringify({ projects: {} }));
    const env = { ...process.env, HCOORD_CLAUDE_JSON: claudeJson };
    await cli(home, ["project", "new", "demo", "--repo", repo], undefined, env);
    const b = JSON.parse((await cli(home, ["board", "--json"], undefined, env)).stdout);
    expect(b.projects[0].trusted).toBe(false);
    expect((await cli(home, ["board"], undefined, env)).stdout).toContain(`Claude doesn't trust ${repo}`);
  });
});

describe("sync and quiet mutations", () => {
  test("sync with nothing to do changes no file, even with a task waiting on another", async () => {
    setup();
    await ok("project", "new", "demo", "--repo", repo, "--prefix", "DM");
    await ok("task", "add", "--title", "First", "--brief", "b");
    await ok("task", "add", "--title", "Second", "--brief", "b", "--depends-on", "DM-1");
    // Queue DM-2 by hand: it can't start until DM-1 is done, so every schedule looks and finds nothing.
    const file = join(home, "projects", "demo", "tasks.json");
    const tf = JSON.parse(readFileSync(file, "utf8"));
    tf.tasks[1].state = "queued";
    writeFileSync(file, JSON.stringify(tf));
    const before = statSync(file).mtimeMs;
    const log = readFileSync(join(home, "projects", "demo", "events.log"), "utf8");
    await Bun.sleep(20);

    expect(await ok("sync")).toBe("");
    expect(await ok("sync", "demo")).toBe("");
    expect(statSync(file).mtimeMs).toBe(before);
    expect(readFileSync(join(home, "projects", "demo", "events.log"), "utf8")).toBe(log);
  });

  test("sync of an unknown project fails", async () => {
    setup();
    expect((await cli(home, ["sync", "nope"])).code).toBe(1);
  });
});

describe("mod install", () => {
  test("copies the mod with this bun and cli.ts, and never replaces a folder it didn't make", async () => {
    setup();
    app = tempDir("herdr-app");
    mkdirSync(join(app, "mods"));
    const env = { ...process.env, HERDR_APP_HOME: app };
    // A temp data root (every test's) is refused unless it's said to be a throwaway.
    const refused = await cli(home, ["mod", "install"], undefined, env);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("temporary folder");
    const r = await cli(home, ["mod", "install", "--temp"], undefined, env);
    expect(r.code).toBe(0);
    const dest = join(app, "mods", "hcoord");
    for (const f of ["main.js", "mod.json", "hcoord-path.js", ".hcoord-installed"]) expect(existsSync(join(dest, f))).toBe(true);
    const path = readFileSync(join(dest, "hcoord-path.js"), "utf8");
    // A non-default data root goes through env(1), since the app's exec takes no environment.
    expect(path).toContain(`"HCOORD_HOME=${home}"`);
    expect(path).toMatch(/src\/cli\.ts"\]/);
    expect(JSON.parse(readFileSync(join(dest, "mod.json"), "utf8")).place).toBe("none");

    // Again: fine (it's ours). Someone else's folder: refused.
    expect((await cli(home, ["mod", "install", "--temp"], undefined, env)).code).toBe(0);
    rmSync(join(dest, ".hcoord-installed"));
    const again = await cli(home, ["mod", "install", "--temp"], undefined, env);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("wasn't installed by hcoord");
  });

  test("a plain copy of mods/hcoord works as it is, and install turns it into a real install", async () => {
    setup();
    app = tempDir("herdr-app");
    const dest = join(app, "mods", "hcoord");
    const source = join(import.meta.dir, "..", "mods", "hcoord");
    const committed = readFileSync(join(source, "hcoord-path.js"), "utf8");
    // Gallery folders hold just their own files: the default must not need `mod install` to load.
    expect(committed).toContain("export const HCOORD = null;");
    mkdirSync(join(app, "mods"));
    cpSync(source, dest, { recursive: true });

    const r = await cli(home, ["mod", "install", "--temp"], undefined, { ...process.env, HERDR_APP_HOME: app });
    expect(r.code).toBe(0);
    const path = readFileSync(join(dest, "hcoord-path.js"), "utf8");
    expect(path).toMatch(/src\/cli\.ts"\]/);
    expect(path).not.toContain("HCOORD = null");
    expect(existsSync(join(dest, ".hcoord-installed"))).toBe(true);
    // The repo's own file is the default still.
    expect(readFileSync(join(source, "hcoord-path.js"), "utf8")).toBe(committed);
  });
});
