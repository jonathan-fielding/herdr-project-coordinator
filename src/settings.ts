import { existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, readJson, withLock } from "./fsutil.ts";
import { paths } from "./paths.ts";
import { loadProject } from "./store.ts";

/** A project's settings, shared by all of its worktrees. */
export interface Settings {
  /** Text for the agent that cleans up when a worktree is deleted. May span lines. "": none. */
  cleanupPrompt: string;
}

/** To add a setting: add it to Settings and give it a default here. Reading and saving follow. */
export const DEFAULT_SETTINGS: Readonly<Settings> = { cleanupPrompt: "" };

const settingsJson = (slug: string) => join(paths.project(slug), "settings.json");

/** Defaults, overlaid with whatever the file holds of the right type, so an older file still reads. */
function normalize(raw: unknown): Settings {
  const file = (raw ?? {}) as Record<string, unknown>;
  const settings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(settings)) {
    if (typeof file[key] === typeof settings[key]) settings[key] = file[key];
  }
  return settings as unknown as Settings;
}

function read(slug: string): Settings {
  return normalize(existsSync(settingsJson(slug)) ? readJson(settingsJson(slug)) : null);
}

/** A project's settings, by slug or task prefix. An unknown project is an error. */
export function loadSettings(slug: string): Settings {
  return read(loadProject(slug).slug);
}

/** Changes the given settings, keeps the rest, and returns them all. */
export async function saveSettings(slug: string, changes: Partial<Settings>): Promise<Settings> {
  const project = loadProject(slug).slug;
  return withLock(paths.lock(project), () => {
    const settings = normalize({ ...read(project), ...changes });
    atomicWrite(settingsJson(project), JSON.stringify(settings, null, 2) + "\n");
    return settings;
  });
}
