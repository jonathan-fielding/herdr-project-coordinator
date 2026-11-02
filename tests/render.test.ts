import { describe, expect, test } from "bun:test";
import type { Task, TaskState } from "../src/model.ts";
import { renderTasksMd } from "../src/render.ts";
import type { ProjectMeta, TaskFile } from "../src/store.ts";

const meta: ProjectMeta = {
  version: 1,
  slug: "demo",
  name: "Demo",
  prefix: "DEM",
  repo: "/r",
  lanes: {
    root: { path: "/r", branch: "main", createdAt: "x" },
    login: { path: "/w/login", branch: "feature/login", createdAt: "x" },
  },
  createdAt: "2026-01-01T00:00:00.000Z",
};

function t(n: number, state: TaskState, extra: Partial<Task> = {}): Task {
  return {
    id: `DEM-${n}`,
    title: `Task ${n}`,
    brief: "b",
    state,
    repo: "/r",
    lane: "root",
    branch: `coord/root/dem-${n}`,
    dependsOn: [],
    createdAt: "x",
    updatedAt: "x",
    ...extra,
  };
}

const file = (tasks: Task[]): TaskFile => ({ version: 1, nextId: tasks.length + 1, tasks });

describe("TASKS.md", () => {
  test("empty project", () => {
    expect(renderTasksMd(meta, file([]))).toBe(
      "# Demo: tasks\n\n<!-- Written by hcoord from tasks.json. Edits here are overwritten; use hcoord. -->\n\n_No tasks yet._\n",
    );
  });

  test("groups in urgency order, numeric id order, notes and pending deps", () => {
    const md = renderTasksMd(
      meta,
      file([
        t(10, "merged", { summary: "Added the form.\nTests pass." }),
        t(14, "done", { summary: "x", mergeError: "conflicts in a.ts" }),
        t(15, "working", { lane: "login" }),
        t(2, "working"),
        t(3, "todo", { dependsOn: ["DEM-2", "DEM-10"] }),
        t(1, "needs_you", { needsYouReason: "Postgres or SQLite?" }),
        t(4, "starting"),
        t(11, "queued"),
        t(12, "failed", { summary: "worker exited (signal 9)" }),
        t(13, "cancelled"),
        t(9, "working"),
      ]),
    );
    expect(md).toBe(
      [
        "# Demo: tasks",
        "",
        "<!-- Written by hcoord from tasks.json. Edits here are overwritten; use hcoord. -->",
        "",
        "## Worktree root (main)",
        "",
        "### Needs you (1)",
        "",
        "- **DEM-1** Task 1",
        "  Postgres or SQLite?",
        "",
        "### Working (3)",
        "",
        "- **DEM-2** Task 2",
        "- **DEM-4** Task 4 _(starting)_",
        "- **DEM-9** Task 9",
        "",
        "### Queued (1)",
        "",
        "- **DEM-11** Task 11",
        "",
        "### To do (1)",
        "",
        "- **DEM-3** Task 3 · waits for DEM-2 (working)",
        "",
        "### Failed (1)",
        "",
        "- **DEM-12** Task 12",
        "  worker exited (signal 9)",
        "",
        "### Done, not merged (1)",
        "",
        "- **DEM-14** Task 14",
        "  not merged: conflicts in a.ts",
        "",
        "### Merged (1)",
        "",
        "- **DEM-10** Task 10",
        "  Added the form. Tests pass.",
        "",
        "### Cancelled (1)",
        "",
        "- **DEM-13** Task 13",
        "",
        "## Worktree login (feature/login)",
        "",
        "### Working (1)",
        "",
        "- **DEM-15** Task 15",
        "",
      ].join("\n"),
    );
  });

  test("is pure: same input renders identically", () => {
    const f = file([t(1, "todo"), t(2, "done")]);
    expect(renderTasksMd(meta, f)).toBe(renderTasksMd(meta, structuredClone(f)));
  });

  test("titles with newlines stay on one line", () => {
    const md = renderTasksMd(meta, file([t(1, "todo", { title: "two\nlines" })]));
    expect(md).toContain("- **DEM-1** two lines\n");
  });
});
