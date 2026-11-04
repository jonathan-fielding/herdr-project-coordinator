// The "Set up git in <name>?" dialog in mods/hcoord/main.js, from the folder button to the first commit.
// The mod is the real one and `hcoord project new` is the real CLI, running real git in temp folders. Herdr's
// modules and UI elements are stand-ins, and `lane open` and `board` are answered here.
//
// The CLI runs with Bun.spawnSync, so everything else the mod does is promise callbacks: one turn of the
// event loop (`settled`) finishes it, and no test waits on a clock.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, tempDir } from "./helpers.ts";
import { byId, el, textOf } from "./mod-stand-ins.ts";

/** A copy of the mod beside the hcoord-path.js that `hcoord mod install` would write. */
function modCopy() {
  const source = join(import.meta.dir, "..", "mods", "hcoord");
  const dir = tempDir("mod");
  copyFileSync(join(source, "main.js"), join(dir, "main.js"));
  writeFileSync(join(dir, "hcoord-path.js"), 'export const HCOORD = ["hcoord"];\n');
  return dir;
}
const MOD_DIRS = [modCopy(), modCopy()];

type Answer = { code: number; stdout: string; stderr: string };

// What the stand-in Herdr reports and remembers, reset for each test.
const world = {
  root: "",
  props: {} as any,
  overlays: [] as any[],
  closed: [] as string[],
  notes: [] as any[],
  /** Everything the mod asked of Herdr and hcoord, in order: "run <name>", "close <id>", "shared <key>", "<hcoord args>". */
  events: [] as string[],
  shared: {} as Record<string, any>,
  stored: {} as Record<string, string>,
  picked: null as string | null,
  /** Mod commands sent while no sidebar was listening, and the sidebars listening. */
  commands: [] as string[],
  listening: [] as ((c: string) => void)[],
  laneAnswer: { code: 0, stdout: "", stderr: "" } as Answer,
  /** Set: answers an hcoord command in place of the real CLI, when it returns anything. */
  answer: null as ((args: string[]) => Answer | undefined) | null,
  /** Set: a real `--git-init` run waits for this. */
  gate: null as Promise<void> | null,
};

/** No git setting of the person's and nothing of theirs on disk: only this test's config, home and data folder. */
function isolatedEnv() {
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_") && !k.startsWith("HCOORD_") && k !== "EMAIL") env[k] = v;
  return {
    ...env,
    HOME: world.root,
    HCOORD_HOME: join(world.root, "data"),
    HCOORD_CLAUDE_JSON: join(world.root, "claude.json"),
    GIT_CONFIG_GLOBAL: join(world.root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
}
const realCli = (args: string[]): Answer => {
  const p = Bun.spawnSync(["bun", CLI, ...args], { env: isolatedEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
};
function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { env: isolatedEnv(), stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
  return p.stdout.toString().trim();
}

mock.module("gpui-kit", () => ({ View: class {}, div: el, svg: el }));
mock.module("gpui-base", () => ({ v_flex: el, h_flex: el, TextView: class {}, InputState: { new: () => ({}) }, Input: { new: () => ({}) }, Scrollbar: { vertical: () => ({}) } }));
mock.module("herdr", () => ({
  agents: () => [],
  terminals: () => [],
  panes: () => [],
  spaces: () => [],
  focused: () => null,
  // A mod's own commands: every sidebar waiting in nextCommand() gets one, which is the most it could be.
  run: (name: string) => {
    world.events.push(`run ${name}`);
    if (!name.startsWith("hcoord.")) return;
    const command = name.slice("hcoord.".length);
    const listening = world.listening.splice(0);
    if (!listening.length) world.commands.push(command);
    for (const hear of listening) hear(command);
  },
  nextCommand: () => {
    const queued = world.commands.shift();
    return queued ? Promise.resolve(queued) : new Promise((hear) => world.listening.push(hear));
  },
  exec: async (_program: string, args: string[]) => {
    world.events.push(args.join(" "));
    if (world.gate && isRealRun(args.join(" "))) await world.gate;
    const answer = world.answer?.(args);
    if (answer) return answer;
    if (args[0] === "board") return { code: 0, stdout: JSON.stringify({ root: "/data", worktreeRoot: "/worktrees", projects: [] }), stderr: "" };
    if (args[0] === "lane") return world.laneAnswer;
    if (args[0] === "project") return realCli(args);
    throw new Error(`nothing stands in for hcoord ${args.join(" ")}`);
  },
  theme: () => ({}),
  notify: (n: any) => void world.notes.push(n),
  pickFolder: async () => world.picked,
  watchFolder: () => new Promise(() => {}),
  layout: () => null,
  home: () => world.root,
  props: () => world.props,
  openOverlay: (o: any) => void world.overlays.push(o),
  closeOverlay: (id: string) => {
    world.closed.push(id);
    world.events.push(`close ${id}`);
  },
  shared: (key: string) => world.shared[key] ?? null,
  // A copy of the value: the copies of the mod have nothing in memory in common.
  setShared: (key: string, value: any) => {
    world.events.push(`shared ${key}`);
    world.shared[key] = JSON.parse(JSON.stringify(value));
  },
}));

// Two loads of the mod: in Herdr the dialog is another copy of it, with nothing in memory shared with the sidebar's.
const { default: Sidebar } = await import(join(MOD_DIRS[0]!, "main.js"));
const { default: DialogCopy } = await import(join(MOD_DIRS[1]!, "main.js"));

const realLocalStorage = (globalThis as any).localStorage;
beforeAll(() => {
  (globalThis as any).localStorage = {
    getItem: (k: string) => world.stored[k] ?? null,
    setItem: (k: string, v: string) => void (world.stored[k] = v),
  };
});
afterAll(() => {
  (globalThis as any).localStorage = realLocalStorage;
  for (const d of MOD_DIRS) rmSync(d, { recursive: true, force: true });
});

function makeCx() {
  const cx: any = {
    spawn: (fn: (cx: any) => Promise<unknown>) => void Promise.resolve().then(() => fn(cx)),
    notify: () => {},
    stop_propagation: () => {},
    timer: { every: () => {}, after: () => {} },
    focus_handle: () => ({ focus() {} }),
  };
  return cx;
}
const settled = () => new Promise((r) => setTimeout(r, 0));

const IDENTITY = "[user]\n  name = Tess\n  email = tess@example.com\n";
const setGitConfig = (text: string) => writeFileSync(join(world.root, "gitconfig"), text);

let sidebar: any;
let sidebarCx: any;

async function startSidebar() {
  const cx = makeCx();
  const v: any = new Sidebar();
  v.init({}, cx);
  await settled();
  return { v, cx };
}

beforeEach(async () => {
  Object.assign(world, {
    root: tempDir("git-dialog"),
    props: {},
    overlays: [],
    closed: [],
    notes: [],
    events: [],
    shared: {},
    stored: {},
    picked: null,
    commands: [],
    listening: [],
    laneAnswer: { code: 0, stdout: "", stderr: "" },
    answer: null,
    gate: null,
  });
  setGitConfig(IDENTITY);
  writeFileSync(join(world.root, "claude.json"), '{"projects":{}}');
  ({ v: sidebar, cx: sidebarCx } = await startSidebar());
});
afterEach(() => {
  rmSync(world.root, { recursive: true, force: true });
});

/** A plain folder in this test's temp root, holding `files` (path → contents). */
function folder(files: Record<string, string>, at = "plain") {
  const dir = join(world.root, at);
  mkdirSync(dir, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
function gitRepo(files: Record<string, string>, at?: string) {
  const dir = folder(files, at);
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "start");
  return dir;
}

/** The person picks `dir` with the folder button: the sidebar's `new` command, then Herdr's folder picker. */
async function pick(dir: string) {
  world.picked = dir;
  world.events.length = 0;
  await sidebar.newProject(sidebarCx);
  await settled();
}

/** Opens the overlay the sidebar asked for, as Herdr would: the mod again, with the overlay's props and its id. */
function openDialog() {
  const overlay = world.overlays.at(-1);
  world.props = { ...overlay.props, overlay: "ov" };
  const cx = makeCx();
  const v: any = new DialogCopy();
  v.init({}, cx);
  const tree = () => v.render(cx);
  return { v, cx, tree, press: (key: string) => byId(tree(), "hc-git").keyDown({ key }, cx) };
}
async function pickAndOpen(dir: string) {
  await pick(dir);
  expect(world.overlays).toHaveLength(1);
  return openDialog();
}
/** Clicks Set up git and lets everything that follows from it finish. */
async function setUpGit(d: ReturnType<typeof openDialog>) {
  world.events.length = 0;
  byId(d.tree(), "yes").click(null, d.cx);
  await settled();
}

const isDryRun = (e: string) => e.includes("--dry-run");
const isRealRun = (e: string) => e.startsWith("project new") && e.includes("--git-init") && !isDryRun(e);
const projects = () => {
  const dir = join(world.root, "data", "projects");
  return existsSync(dir) ? readdirSync(dir) : [];
};
const toast = () => {
  expect(world.notes).toHaveLength(1);
  return world.notes[0];
};
const expectUntouched = (dir: string) => {
  expect(existsSync(join(dir, ".git"))).toBe(false);
  expect(projects()).toEqual([]);
  expect(world.events.filter(isRealRun)).toEqual([]);
};

describe("what the dialog says", () => {
  test("a plain folder with no .gitignore: the warning and the files, and nothing done yet", async () => {
    const dir = folder({ "a.txt": "1", "node_modules/x.js": "2" });
    const { tree } = await pickAndOpen(dir);
    expect(world.overlays[0]).toMatchObject({ mod: "hcoord", kind: "dialog", props: { gitInit: { name: "plain", folder: dir } } });
    expect(world.notes).toEqual([]);
    const text = textOf(tree());
    expect(text).toContain("Set up git in plain?");
    expect(text).toContain("~/plain isn't a git repo yet");
    expect(text).toContain("There's no .gitignore");
    expect(text).toContain("2 files will be committed:");
    expect(textOf(byId(tree(), "hc-git-files"))).toBe("a.txt node_modules/x.js");
    expectUntouched(dir);
  });

  test("with a .gitignore: no warning, and ignored files aren't listed", async () => {
    const { tree } = await pickAndOpen(folder({ "a.txt": "1", ".gitignore": "*.log\n", "x.log": "n" }));
    const text = textOf(tree());
    expect(text).not.toContain("There's no .gitignore");
    expect(text).toContain("2 files will be committed:");
    expect(textOf(byId(tree(), "hc-git-files"))).toBe(".gitignore a.txt");
  });

  test("one file", async () => {
    const { tree } = await pickAndOpen(folder({ "a.txt": "1" }));
    expect(textOf(tree())).toContain("1 file will be committed:");
  });

  test("an empty folder: says the commit will be empty, with no .gitignore warning", async () => {
    const { tree } = await pickAndOpen(folder({}));
    const text = textOf(tree());
    expect(text).toContain("The folder has no files to commit, so the first commit will be empty.");
    expect(text).not.toContain("will be committed:");
    expect(text).not.toContain("There's no .gitignore");
  });

  const numbered = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${String(i).padStart(3, "0")}`, "x"]));

  test("over the CLI's cap of 200: the first 200, then how many more", async () => {
    const { tree } = await pickAndOpen(folder(numbered(206)));
    const files = byId(tree(), "hc-git-files");
    expect(textOf(tree())).toContain("206 files will be committed:");
    expect(files.kids).toHaveLength(201);
    expect(textOf(files.kids[199])).toBe("f199");
    expect(textOf(files.kids[200])).toBe("and 6 more");
  });

  test("exactly 200 files: all listed, no 'more' line", async () => {
    const { tree } = await pickAndOpen(folder(numbered(200)));
    const files = byId(tree(), "hc-git-files");
    expect(files.kids).toHaveLength(200);
    expect(textOf(files)).not.toContain("more");
  });
});

describe("leaving without setting up", () => {
  test("Cancel closes the dialog and commits nothing", async () => {
    const dir = folder({ "a.txt": "1" });
    const d = await pickAndOpen(dir);
    byId(d.tree(), "no").click(null, d.cx);
    await settled();
    expect(world.closed).toEqual(["ov"]);
    expectUntouched(dir);
  });

  test("Esc closes the dialog and commits nothing", async () => {
    const dir = folder({ "a.txt": "1" });
    const d = await pickAndOpen(dir);
    d.press("escape");
    await settled();
    expect(world.closed).toEqual(["ov"]);
    expectUntouched(dir);
  });

  test("Enter does nothing: only the button commits", async () => {
    const dir = folder({ "a.txt": "1" });
    const d = await pickAndOpen(dir);
    d.press("enter");
    await settled();
    expect(world.closed).toEqual([]);
    expectUntouched(dir);
  });
});

describe("Set up git", () => {
  test("makes one real commit of what the dialog listed, honouring .gitignore", async () => {
    const dir = folder({ "a.txt": "1", "sub/b.txt": "2", ".gitignore": "*.log\n", "x.log": "n" });
    const d = await pickAndOpen(dir);
    const listed = textOf(byId(d.tree(), "hc-git-files")).split(" ");
    await setUpGit(d);
    expect(git(dir, "log", "--format=%s|%an|%ae")).toBe("Initial commit|Tess|tess@example.com");
    expect(git(dir, "ls-tree", "-r", "--name-only", "HEAD").split("\n")).toEqual(listed);
    expect(listed).toEqual([".gitignore", "a.txt", "sub/b.txt"]);
    expect(existsSync(join(dir, "x.log"))).toBe(true);
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(projects()).toEqual(["plain"]);
    expect(world.events.filter(isRealRun)).toHaveLength(1);
  });

  test("then the sidebar warns about trust, unfolds the project, starts the coordinator and refreshes", async () => {
    const dir = folder({ "a.txt": "1" });
    const d = await pickAndOpen(dir);
    await setUpGit(d);
    expect(world.notes).toEqual([
      expect.objectContaining({ title: "plain: Claude doesn't trust this repo yet", level: "warning", body: expect.stringContaining(dir) }),
    ]);
    expect(sidebar.open["p:plain"]).toBe(true);
    expect(JSON.parse(world.stored.open!)).toEqual({ "p:plain": true });
    const lane = world.events.indexOf(`lane open ${dir}`);
    expect(lane).toBeGreaterThan(-1);
    expect(world.events.indexOf("board --json")).toBeGreaterThan(lane);
    expect(world.closed).toEqual(["ov"]);
  });

  test("a repo Claude already trusts gets no toast", async () => {
    const dir = folder({ "a.txt": "1" });
    writeFileSync(join(world.root, "claude.json"), JSON.stringify({ projects: { [dir]: { hasTrustDialogAccepted: true } } }));
    await setUpGit(await pickAndOpen(dir));
    expect(world.notes).toEqual([]);
    expect(world.events).toContain(`lane open ${dir}`);
  });

  test("a project's slug, not the folder's name, is what gets unfolded", async () => {
    const dir = folder({ "a.txt": "1" }, "My App");
    const d = await pickAndOpen(dir);
    expect(textOf(d.tree())).toContain("Set up git in My App?");
    await setUpGit(d);
    expect(projects()).toEqual(["my-app"]);
    expect(sidebar.open["p:my-app"]).toBe(true);
  });

  test("when the coordinator won't start: the usual toast, and the project stays", async () => {
    const dir = folder({ "a.txt": "1" });
    const d = await pickAndOpen(dir);
    world.laneAnswer = { code: 1, stdout: "", stderr: "no herdr\n" };
    await setUpGit(d);
    expect(world.notes.at(-1)).toMatchObject({ title: "Couldn't start plain's coordinator", body: "no herdr", level: "error" });
    expect(projects()).toEqual(["plain"]);
    expect(world.closed).toEqual(["ov"]);
    expect(world.events).toContain("board --json");
  });
});

describe("when setting up fails", () => {
  test("it stays in the dialog and says why, and a retry works", async () => {
    const dir = folder({ "a.txt": "1" });
    const d = await pickAndOpen(dir);
    setGitConfig(""); // lost after the dry run passed, so the real run is what fails
    await setUpGit(d);
    const text = textOf(d.tree());
    expect(text).toContain("git has no identity to make the first commit with");
    expect(text).not.toContain("hcoord: "); // the CLI's prefix is for a terminal
    expect(world.closed).toEqual([]);
    expect(world.notes).toEqual([]);
    expect(world.shared["hcoord.project-made"]).toBeUndefined();
    expect(world.events.filter((e) => e.startsWith("lane open"))).toEqual([]);
    expect(existsSync(join(dir, ".git"))).toBe(false);

    setGitConfig(IDENTITY);
    await setUpGit(d);
    expect(textOf(d.tree())).not.toContain("git has no identity");
    expect(git(dir, "ls-files")).toBe("a.txt");
    expect(world.closed).toEqual(["ov"]);
    expect(world.events).toContain(`lane open ${dir}`);
  });

  test("with nothing to say, it still says it failed", async () => {
    const d = await pickAndOpen(folder({ "a.txt": "1" }));
    world.answer = (args) => (isRealRun(args.join(" ")) ? { code: 1, stdout: "", stderr: "" } : undefined);
    await setUpGit(d);
    expect(textOf(d.tree())).toContain("hcoord failed");
  });
});

describe("while it runs", () => {
  test("it says so, can't be run twice, and Cancel and Esc wait", async () => {
    const dir = folder({ "a.txt": "1" });
    const d = await pickAndOpen(dir);
    let finish = () => {};
    world.gate = new Promise((r) => (finish = r));
    await setUpGit(d);

    const tree = d.tree();
    expect(textOf(tree)).toContain("Setting up git…");
    expect(byId(tree, "no").click).toBe(null);
    expect(byId(tree, "yes").click).toBe(null);
    d.press("escape");
    expect(world.closed).toEqual([]);
    await d.v.doGitInit(d.cx); // what a second click would have run: the button has no click to test
    expect(world.events.filter(isRealRun)).toHaveLength(1);

    finish();
    await settled();
    expect(textOf(d.tree())).not.toContain("Setting up git…");
    expect(world.closed).toEqual(["ov"]);
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
  });
});

describe("a dry run that refuses", () => {
  const expectRefused = (why: string) => {
    expect(world.overlays).toEqual([]);
    expect(toast()).toMatchObject({ title: "Couldn't make plain a project", level: "error" });
    expect(toast().body).toContain(why);
    expect(world.events.some(isDryRun)).toBe(true);
    expect(world.events.filter(isRealRun)).toEqual([]);
    expect(world.events.filter((e) => e.startsWith("lane open"))).toEqual([]);
  };

  test("no git identity: the toast says how to set one, and the folder stays as it was", async () => {
    setGitConfig("[init]\n  defaultBranch = main\n");
    const dir = folder({ "a.txt": "1" });
    await pick(dir);
    expectRefused("git has no identity");
    expect(toast().body).toContain("git config --global user.email");
    expectUntouched(dir);
  });

  test("half an identity is no identity", async () => {
    setGitConfig("[user]\n  name = Tess\n");
    const dir = folder({ "a.txt": "1" });
    await pick(dir);
    expectRefused("user.name / user.email");
    expectUntouched(dir);
  });

  test("a project name in use", async () => {
    expect(realCli(["project", "new", "plain", "--repo", gitRepo({ "a.txt": "1" }, "first/plain")]).code).toBe(0);
    const dir = folder({ "a.txt": "1" }, "second/plain");
    await pick(dir);
    expectRefused('project "plain" already exists');
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  test("a prefix in use", async () => {
    const PREFIX_OF_PLAIN = "PLA";
    expect(realCli(["project", "new", "other", "--prefix", PREFIX_OF_PLAIN, "--repo", gitRepo({ "a.txt": "1" }, "other")]).code).toBe(0);
    const dir = folder({ "a.txt": "1" });
    await pick(dir);
    expectRefused(`prefix ${PREFIX_OF_PLAIN} is used by "other"`);
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });

  test("a .git that isn't a repo", async () => {
    const dir = folder({ "a.txt": "1" });
    mkdirSync(join(dir, ".git"));
    await pick(dir);
    expectRefused("exists but isn't a working git repository");
    expect(readdirSync(join(dir, ".git"))).toEqual([]);
  });

  test("a dry run with nothing to offer keeps the first error", async () => {
    const dir = folder({ "a.txt": "1" });
    world.answer = (args) => (args.includes("--dry-run") ? { code: 0, stdout: '{"gitInit":false}', stderr: "" } : undefined);
    await pick(dir);
    expectRefused("not a git repository");
  });
});

describe("the ordinary way", () => {
  test("a missing folder keeps the ordinary toast, with no dry run", async () => {
    await pick(join(world.root, "gone"));
    expect(world.overlays).toEqual([]);
    expect(toast()).toMatchObject({ title: "Couldn't make gone a project", level: "error", body: expect.stringContaining("no such folder") });
    expect(world.events.some(isDryRun)).toBe(false);
  });

  test("a real repo that can't be a project keeps the ordinary toast, with no dry run", async () => {
    const dir = gitRepo({ "a.txt": "1" });
    expect(realCli(["project", "new", "plain", "--repo", dir]).code).toBe(0);
    await pick(dir);
    expect(world.overlays).toEqual([]);
    expect(toast()).toMatchObject({ title: "Couldn't make plain a project", level: "error", body: expect.stringContaining("already exists") });
    expect(world.events.some(isDryRun)).toBe(false);
  });

  test("a real git repo becomes a project with no dialog and no commit", async () => {
    const dir = gitRepo({ "a.txt": "1" });
    await pick(dir);
    expect(world.overlays).toEqual([]);
    expect(world.events.some((e) => e.includes("--git-init"))).toBe(false);
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("1");
    expect(projects()).toEqual(["plain"]);
    expect(sidebar.open["p:plain"]).toBe(true);
    expect(world.events).toContain(`lane open ${dir}`);
  });
});

// The dialog is a copy of the mod with no sidebar state, so it hands the sidebar the result. Here the stand-in
// carries `run` to `nextCommand`, so these show both ends of the route, not that Herdr joins them.
describe("from the dialog to the sidebar", () => {
  test("the result goes in shared state before the command, and the dialog closes before the coordinator starts", async () => {
    const dir = folder({ "a.txt": "1" });
    await setUpGit(await pickAndOpen(dir));
    const route = world.events.filter((e) => e.includes("hcoord.project-made") || e === "close ov" || e.startsWith("lane open"));
    expect(route).toEqual([
      "shared hcoord.project-made", // the dialog leaves the result
      "run hcoord.project-made",
      "close ov",
      "shared hcoord.project-made", // the sidebar takes it
      `lane open ${dir}`,
    ]);
  });

  test("the result waits in shared state until the sidebar takes it, once", async () => {
    const dir = folder({ "a.txt": "1" });
    const d = await pickAndOpen(dir);
    const sidebarBusy = world.listening.splice(0);
    await d.v.doGitInit(d.cx);
    const left = world.shared["hcoord.project-made"];
    expect(left).toMatchObject({ folder: dir, name: "plain" });
    expect(JSON.parse(left.stdout)).toMatchObject({ slug: "plain", repo: dir });
    expect(left.text).toContain("warning:");
    expect(world.events.filter((e) => e.startsWith("lane open"))).toEqual([]);

    for (const hear of sidebarBusy) hear(world.commands.shift()!);
    await settled();
    expect(world.shared["hcoord.project-made"]).toBe(null);
    expect(world.events.filter((e) => e === `lane open ${dir}`)).toHaveLength(1);

    world.events.length = 0;
    await sidebar.projectMadeInDialog(sidebarCx); // a repeat of the command finds nothing
    expect(world.events).toEqual([]);
  });

  test("with two sidebars, one of them finishes the job", async () => {
    const other = await startSidebar();
    const dir = folder({ "a.txt": "1" });
    await setUpGit(await pickAndOpen(dir));
    expect(world.listening).toHaveLength(2); // both took the command and went back to listening
    expect(world.events.filter((e) => e === `lane open ${dir}`)).toHaveLength(1);
    expect(world.notes).toHaveLength(1);
    expect([sidebar, other.v].filter((s) => s.open["p:plain"])).toHaveLength(1);
  });
});
