import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Data root. `HCOORD_HOME` overrides it (tests use a temp folder). */
export function root(): string {
  return process.env.HCOORD_HOME || join(homedir(), ".herdr-coordinator");
}

/** Folders the system may empty (on a reboot, or after days unused). */
function tempFolders(): string[] {
  const list = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders", "/var/tmp", "/private/var/tmp", tmpdir()];
  try {
    list.push(realpathSync(tmpdir()));
  } catch {}
  return list.map((d) => d.replace(/\/+$/, ""));
}

/** Whether a folder is inside a temporary one. */
export function isTemporary(path: string): boolean {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {}
  return tempFolders().some((d) => [path, real].some((p) => p === d || p.startsWith(d + "/")));
}

/** A warning when the data root is somewhere the system may empty; null when it's safe. */
export function rootWarning(): string | null {
  return isTemporary(root())
    ? `hcoord's data folder ${root()} is a temporary folder: the system may empty it, and projects' tasks, reports and notes would go with it. Move it (e.g. to ~/.herdr-coordinator) and reinstall the mod without HCOORD_HOME.`
    : null;
}

export const paths = {
  config: () => join(root(), "config.json"),
  /** Guards project creation (slug and prefix uniqueness). */
  rootLock: () => join(root(), ".lock"),
  projects: () => join(root(), "projects"),
  project: (slug: string) => join(root(), "projects", slug),
  projectJson: (slug: string) => join(root(), "projects", slug, "project.json"),
  projectMd: (slug: string) => join(root(), "projects", slug, "PROJECT.md"),
  tasksJson: (slug: string) => join(root(), "projects", slug, "tasks.json"),
  tasksMd: (slug: string) => join(root(), "projects", slug, "TASKS.md"),
  memoryMd: (slug: string) => join(root(), "projects", slug, "MEMORY.md"),
  reports: (slug: string) => join(root(), "projects", slug, "reports"),
  eventsLog: (slug: string) => join(root(), "projects", slug, "events.log"),
  /** Serialises every write to this project's tasks.json / TASKS.md / events.log. */
  lock: (slug: string) => join(root(), "projects", slug, ".lock"),
};
