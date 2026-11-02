import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, tempDir, tempRepo } from "./helpers.ts";

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

const run = (...args: string[]) => cli(home, args);
const ok = async (...args: string[]) => {
  const r = await cli(home, args);
  if (r.code !== 0) throw new Error(`hcoord ${args.join(" ")} → ${r.code}: ${r.stderr}`);
  return r.stdout;
};

describe("project", () => {
  test("new creates the folder, files, config and first event", async () => {
    const outText = await ok("project", "new", "Quiet Harbour Quay", "--repo", join(repo, "src"));
    expect(outText).toContain("created quiet-harbour-quay (tasks QHQ-n)");
    const p = join(home, "projects", "quiet-harbour-quay");
    for (const f of ["project.json", "PROJECT.md", "tasks.json", "TASKS.md", "MEMORY.md", "events.log", "reports"]) {
      expect(existsSync(join(p, f))).toBe(true);
    }
    const meta = JSON.parse(readFileSync(join(p, "project.json"), "utf8"));
    // A subfolder resolves to the repo root.
    expect(meta).toMatchObject({ slug: "quiet-harbour-quay", prefix: "QHQ", repos: [repo] });
    expect(readFileSync(join(p, "PROJECT.md"), "utf8")).toContain(`- ${repo}`);
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(config).toMatchObject({ agent: { kind: "claude" }, maxParallel: 3 });
  });

  test("refuses duplicates, prefix clashes, bad prefixes and non-repos", async () => {
    await ok("project", "new", "website", "--repo", repo);
    expect((await run("project", "new", "Website", "--repo", repo)).stderr).toContain('project "website" already exists');
    expect((await run("project", "new", "webapp", "--repo", repo)).stderr).toContain("prefix WEB is used by \"website\"");
    expect((await run("project", "new", "webapp", "--repo", repo, "--prefix", "1x")).code).toBe(2);
    const notRepo = tempDir("plain");
    const r = await run("project", "new", "plain", "--repo", notRepo);
    rmSync(notRepo, { recursive: true });
    expect(r).toMatchObject({ code: 1 });
    expect(r.stderr).toContain("not a git repository");
    expect((await run("project", "new", "norepo")).stderr).toContain("at least one --repo");
  });

  test("list and show", async () => {
    await ok("project", "new", "alpha", "--repo", repo);
    await ok("project", "new", "beta", "--repo", repo, "--repo", repo2);
    const list = JSON.parse(await ok("project", "list", "--json"));
    expect(list.map((p: any) => p.slug)).toEqual(["alpha", "beta"]);
    expect(list[1].repos).toEqual([repo, repo2]);
    expect(await ok("project", "show", "beta")).toContain("tasks:   none");
    // Two projects: a slug is required.
    expect((await run("task", "list")).stderr).toContain("name a project (alpha, beta)");
  });
});

describe("task", () => {
  beforeEach(async () => {
    await ok("project", "new", "demo", "--repo", repo, "--repo", repo2, "--prefix", "DM");
  });

  test("add, with dependencies, list and show", async () => {
    const briefFile = join(home, "brief.md");
    writeFileSync(briefFile, "Build the schema.\nOwn: db/ only.\n");
    expect((await ok("task", "add", "demo", "--title", "DB schema", "--brief-file", briefFile)).trim()).toBe("DM-1");
    expect((await ok("task", "add", "demo", "--title", "API", "--brief", "Endpoints", "--depends-on", "dm-1")).trim()).toBe("DM-2");
    const third = JSON.parse(
      await ok("task", "add", "--title", "UI", "--brief", "Screens", "--depends-on", "DM-1,DM-2", "--repo", repo2, "--json"),
    );
    expect(third).toMatchObject({
      id: "DM-3",
      state: "todo",
      repo: repo2,
      branch: "coord/dm-3-ui",
      dependsOn: ["DM-1", "DM-2"],
    });

    // Only one project, so the slug can be left out.
    const listed = await ok("task", "list");
    expect(listed.split("\n").filter(Boolean)).toEqual([
      "DM-1      todo       DB schema",
      "DM-2      todo       API  (after DM-1)",
      "DM-3      todo       UI  (after DM-1, DM-2)",
    ]);
    const json = JSON.parse(await ok("task", "list", "demo", "--json"));
    expect(json.map((t: any) => t.id)).toEqual(["DM-1", "DM-2", "DM-3"]);
    expect(JSON.parse(await ok("task", "list", "demo", "--state", "done", "--json"))).toEqual([]);

    const shown = await ok("task", "show", "dm-3");
    expect(shown).toContain("DM-3  UI");
    expect(shown).toContain("depends on: DM-1 (todo), DM-2 (todo)");
    expect(shown).toContain("branch:     coord/dm-3-ui");
    const shownJson = JSON.parse(await ok("task", "show", "DM-1", "--json"));
    expect(shownJson).toMatchObject({ project: "demo", brief: "Build the schema.\nOwn: db/ only.\n" });

    const md = readFileSync(join(home, "projects", "demo", "TASKS.md"), "utf8");
    expect(md).toContain("- **DM-2** API · waits for DM-1 (todo)");
    const events = readFileSync(join(home, "projects", "demo", "events.log"), "utf8").trim().split("\n");
    expect(events).toHaveLength(4);
    expect(JSON.parse(events[3]!)).toMatchObject({ type: "task.created", task: "DM-3", to: "todo", project: "demo" });
  });

  test("the task prefix works in place of the slug", async () => {
    expect((await ok("task", "add", "dm", "--title", "By prefix", "--brief", "b")).trim()).toBe("DM-1");
    expect(await ok("task", "list", "DM")).toContain("DM-1      todo       By prefix");
    expect(await ok("project", "show", "dm")).toContain("Demo".toLowerCase());
    expect(existsSync(join(home, "projects", "dm"))).toBe(false);
  });

  test("brief from stdin", async () => {
    const r = await cli(home, ["task", "add", "demo", "--title", "From stdin", "--brief-file", "-"], "piped brief\n");
    expect(r.code).toBe(0);
    expect(JSON.parse(await ok("task", "show", "DM-1", "--json")).brief).toBe("piped brief\n");
  });

  test("rejects unknown deps without writing anything", async () => {
    const before = readFileSync(join(home, "projects", "demo", "tasks.json"), "utf8");
    const r = await run("task", "add", "demo", "--title", "x", "--brief", "y", "--depends-on", "DM-9");
    expect(r).toMatchObject({ code: 1 });
    expect(r.stderr).toContain("unknown task in --depends-on: DM-9");
    expect(readFileSync(join(home, "projects", "demo", "tasks.json"), "utf8")).toBe(before);
  });

  test("usage errors exit 2", async () => {
    expect((await run("task", "add", "demo", "--brief", "b")).code).toBe(2); // no title
    expect((await run("task", "add", "demo", "--title", "t")).code).toBe(2); // no brief
    expect((await run("task", "add", "demo", "--title", "t", "--brief", "b", "--brief-file", "f")).code).toBe(2);
    expect((await run("task", "add", "demo", "--title", "t", "--brief", "b", "--bogus")).code).toBe(2);
    expect((await run("task", "list", "demo", "--state", "nope")).code).toBe(2);
    expect((await run("task", "frobnicate")).code).toBe(2);
  });

  test("a repo outside the project is refused", async () => {
    const other = tempRepo("other");
    const r = await run("task", "add", "demo", "--title", "t", "--brief", "b", "--repo", other);
    rmSync(other, { recursive: true });
    expect(r.stderr).toContain("isn't one of demo's repos");
  });

  test("show for unknown ids", async () => {
    expect((await run("task", "show", "DM-7")).stderr).toContain('no task DM-7 in "demo"');
    expect((await run("task", "show", "ZZ-1")).stderr).toContain('no project has task prefix "ZZ"');
  });
});
