import { homedir } from "node:os";
import { join } from "node:path";

/** Data root. `HCOORD_HOME` overrides it (tests use a temp folder). */
export function root(): string {
  return process.env.HCOORD_HOME || join(homedir(), ".herdr-coordinator");
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
