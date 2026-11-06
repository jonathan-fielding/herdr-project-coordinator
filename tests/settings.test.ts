/** Project settings: src/settings.ts and hcoord settings show/set. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/paths.ts";
import { loadSettings, saveSettings } from "../src/settings.ts";
import { createProject } from "../src/store.ts";
import { CLI, cli, tempDir, tempRepo, useTempHome } from "./helpers.ts";

describe("loadSettings and saveSettings", () => {
  let store: ReturnType<typeof useTempHome>;
  let repo: string;
  let file: string;

  beforeEach(async () => {
    store = useTempHome();
    repo = tempRepo("app");
    await createProject({ name: "Demo", repo, prefix: "DMO" });
    file = join(paths.project("demo"), "settings.json");
  });
  afterEach(() => {
    store.cleanup();
    rmSync(repo, { recursive: true, force: true });
  });

  test("a missing file reads as defaults", () => {
    expect(existsSync(file)).toBe(false);
    expect(loadSettings("demo")).toEqual({ cleanupPrompt: "" });
  });

  test.each([
    ["no settings yet", "{}"],
    ["an older setting only", `{ "retired": true }`],
    ["the wrong type", `{ "cleanupPrompt": 3 }`],
    ["not an object", "null"],
  ])("%s reads as defaults", (_name, text) => {
    writeFileSync(file, text);
    expect(loadSettings("demo")).toEqual({ cleanupPrompt: "" });
  });

  test("a damaged file is an error, not silently empty", () => {
    writeFileSync(file, "{ oops");
    expect(() => loadSettings("demo")).toThrow(/invalid JSON/);
  });

  test("saved text round trips, beside project.json, with no temp files left", async () => {
    const text = 'Stop the "dev" server.\n\n  Then remove .env.local\n';
    expect(await saveSettings("demo", { cleanupPrompt: text })).toEqual({ cleanupPrompt: text });
    expect(loadSettings("demo")).toEqual({ cleanupPrompt: text });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ cleanupPrompt: text });
    expect(existsSync(paths.projectJson("demo"))).toBe(true);
    expect(readdirSync(paths.project("demo")).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  test("a task prefix finds the project", async () => {
    await saveSettings("dmo", { cleanupPrompt: "tidy" });
    expect(loadSettings("demo").cleanupPrompt).toBe("tidy");
    expect(loadSettings("DMO").cleanupPrompt).toBe("tidy");
  });

  test("an unknown project is an error", async () => {
    expect(() => loadSettings("nope")).toThrow('no project "nope"');
    await expect(saveSettings("nope", { cleanupPrompt: "x" })).rejects.toThrow('no project "nope"');
  });
});

describe("hcoord settings", () => {
  let home: string;
  let repo: string;
  let repo2: string;

  beforeEach(() => {
    home = tempDir("home");
    repo = tempRepo("app");
    repo2 = tempRepo("lib");
  });
  afterEach(() => {
    for (const d of [home, repo, repo2]) rmSync(d, { recursive: true, force: true });
  });

  const env = () => ({ ...process.env, HCOORD_NO_TRASH: "1" });
  const ok = async (args: string[], stdin?: string) => {
    const r = await cli(home, args, stdin, env());
    if (r.code !== 0) throw new Error(`hcoord ${args.join(" ")} → ${r.code}: ${r.stderr}`);
    return r.stdout;
  };
  const show = async (...args: string[]) => JSON.parse(await ok(["settings", "show", ...args, "--json"]));
  const project = (name: string, r: string) => ok(["project", "new", name, "--repo", r]);

  test("show gives exactly the defaults for a new project", async () => {
    await project("Demo", repo);
    expect(await show("demo")).toEqual({ cleanupPrompt: "" });
  });

  test("multi-line text through stdin is saved, trimmed only at its ends", async () => {
    await project("Demo", repo);
    await ok(["settings", "set", "demo", "--cleanup-prompt-file", "-"], "\n  line one\n\n    line two  \n\n");
    expect(await show("demo")).toEqual({ cleanupPrompt: "line one\n\n    line two" });
    expect(await ok(["settings", "show", "demo"])).toContain("cleanup prompt:\n  line one");
  });

  test("text comes from a file too", async () => {
    await project("Demo", repo);
    const file = join(home, "prompt.md");
    writeFileSync(file, "from a file\nsecond line\n");
    await ok(["settings", "set", "demo", "--cleanup-prompt-file", file]);
    expect(await show("demo")).toEqual({ cleanupPrompt: "from a file\nsecond line" });
  });

  test.each([
    ["empty", ""],
    ["only whitespace", " \n\t\n"],
  ])("%s text clears it", async (_name, text) => {
    await project("Demo", repo);
    await ok(["settings", "set", "demo", "--cleanup-prompt-file", "-"], "tidy up");
    expect(await ok(["settings", "set", "demo", "--cleanup-prompt-file", "-"], text)).toContain("cleared");
    expect(await show("demo")).toEqual({ cleanupPrompt: "" });
  });

  test("the project defaults to $HCOORD_PROJECT", async () => {
    await project("Demo", repo);
    await project("Lib", repo2);
    const run = (args: string[], stdin?: string) => {
      const r = Bun.spawnSync(["bun", CLI, "settings", ...args], {
        env: { ...process.env, HCOORD_HOME: home, HCOORD_PROJECT: "lib" },
        stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      });
      expect(r.exitCode).toBe(0);
      return r.stdout.toString();
    };
    run(["set", "--cleanup-prompt-file", "-"], "for lib");
    expect(JSON.parse(run(["show", "--json"]))).toEqual({ cleanupPrompt: "for lib" });
    expect(await show("lib")).toEqual({ cleanupPrompt: "for lib" });
    expect(await show("demo")).toEqual({ cleanupPrompt: "" });
  });

  test("an unknown project is a clear error and writes nothing", async () => {
    await project("Demo", repo);
    const shown = await cli(home, ["settings", "show", "nope", "--json"]);
    expect(shown.code).toBe(1);
    expect(shown.stderr).toContain('no project "nope" (projects: demo)');
    const set = await cli(home, ["settings", "set", "nope", "--cleanup-prompt-file", "-"], "text");
    expect(set.code).toBe(1);
    expect(set.stderr).toContain('no project "nope"');
    expect(existsSync(join(home, "projects", "nope"))).toBe(false);
  });

  test("set needs the file option, and a file that can be read", async () => {
    await project("Demo", repo);
    expect((await cli(home, ["settings", "set", "demo"])).code).toBe(2);
    const missing = await cli(home, ["settings", "set", "demo", "--cleanup-prompt-file", join(home, "absent")]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("can't read");
  });

  test("deleting a project moves its settings to the archive", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ version: 1, agent: { kind: "generic", command: ["true"] } }));
    await project("Demo", repo);
    await ok(["settings", "set", "demo", "--cleanup-prompt-file", "-"], "keep me");
    await ok(["project", "delete", "demo"]);
    const [archive] = readdirSync(join(home, "deleted"));
    expect(JSON.parse(readFileSync(join(home, "deleted", archive!, "settings.json"), "utf8"))).toEqual({
      cleanupPrompt: "keep me",
    });
    expect(existsSync(join(home, "projects", "demo"))).toBe(false);
  });
});
