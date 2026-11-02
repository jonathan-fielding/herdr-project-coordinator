import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { HcoordError } from "./errors.ts";

/** Writes via a temp file in the same folder + fsync + rename, so readers never see a partial file. */
export function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "w", 0o644);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

export function readJson<T>(path: string): T {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") throw new HcoordError(`missing file: ${path}`);
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch (e: any) {
    throw new HcoordError(`invalid JSON in ${path}: ${e.message}`);
  }
}

export interface LockOptions {
  /** Give up waiting after this long. */
  timeoutMs?: number;
  /** A lock whose holder is alive is still taken over after this long (a hung holder). */
  staleMs?: number;
}

function readLock(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/** Lock file content: "<pid> <epoch ms> <random>". */
function isStale(path: string, content: string, staleMs: number): boolean {
  const [pidText, timeText] = content.trim().split(" ");
  const pid = Number(pidText);
  const time = Number(timeText);
  if (!Number.isInteger(pid) || !Number.isFinite(time)) {
    // Created but not written yet, or garbage: stale only once it's clearly abandoned.
    try {
      return Date.now() - statSync(path).mtimeMs > 5_000;
    } catch {
      return false;
    }
  }
  return !pidAlive(pid) || Date.now() - time > staleMs;
}

/**
 * Runs `fn` while holding an exclusive lock file (created with O_EXCL). Waiting holders retry
 * with jitter. A lock left by a dead process (or one older than `staleMs`) is taken over.
 */
export async function withLock<T>(
  lockPath: string,
  fn: () => T | Promise<T>,
  { timeoutMs = 15_000, staleMs = 5 * 60_000 }: LockOptions = {},
): Promise<T> {
  const token = `${process.pid} ${Date.now()} ${randomBytes(6).toString("hex")}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o644);
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
    }
    const held = readLock(lockPath);
    if (held !== null && isStale(lockPath, held, staleMs)) {
      // Re-check right before removing, so we don't remove a lock someone just took over.
      if (readLock(lockPath) === held) {
        try {
          unlinkSync(lockPath);
        } catch {}
      }
      continue;
    }
    if (Date.now() > deadline) {
      throw new HcoordError(
        `timed out after ${timeoutMs} ms waiting for ${lockPath} (held by: ${held?.trim() || "unknown"})`,
      );
    }
    await Bun.sleep(3 + Math.random() * 20);
  }
  try {
    return await fn();
  } finally {
    if (readLock(lockPath) === token) {
      try {
        unlinkSync(lockPath);
      } catch {}
    }
  }
}
