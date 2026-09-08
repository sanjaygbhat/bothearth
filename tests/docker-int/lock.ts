/**
 * Docker integration lock.
 * Exclusive lockfile with JSON {pid, host, created_at}; stale-safe.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const DEFAULT_LOCK = join(
  dirname(fileURLToPath(import.meta.url)),
  ".lock",
);

const STALE_MS = 20 * 60 * 1000;

export interface LockHandle {
  release(): void;
}

const held = new Set<string>();
let exitHooked = false;

function ensureExitHook(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    for (const p of held) {
      try {
        unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ESRCH") return false;
    return true;
  }
}

function isStaleLock(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return true;
  }
  let createdMs: number | undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const rec = parsed as { pid?: unknown; host?: unknown; created_at?: unknown };
      if (
        rec.host === hostname() &&
        typeof rec.pid === "number" &&
        Number.isInteger(rec.pid)
      ) {
        if (!pidAlive(rec.pid)) return true;
      }
      if (typeof rec.created_at === "string") {
        const t = Date.parse(rec.created_at);
        if (Number.isFinite(t)) createdMs = t;
      } else if (typeof rec.created_at === "number" && Number.isFinite(rec.created_at)) {
        createdMs = rec.created_at;
      }
    }
  } catch {
    /* malformed — age via mtime */
  }
  if (createdMs !== undefined) {
    return Date.now() - createdMs > STALE_MS;
  }
  try {
    const st = statSync(lockPath);
    return Date.now() - st.mtimeMs > STALE_MS;
  } catch {
    return true;
  }
}

function tryBreakStale(lockPath: string): void {
  if (!isStaleLock(lockPath)) return;
  try {
    unlinkSync(lockPath);
  } catch {
    /* raced */
  }
}

export async function acquireDockerLock(
  lockPath: string = DEFAULT_LOCK,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<LockHandle> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const pollMs = opts.pollMs ?? 200;
  const start = Date.now();
  ensureExitHook();
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            host: hostname(),
            created_at: new Date().toISOString(),
          }),
        );
      } finally {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      held.add(lockPath);
      return {
        release() {
          held.delete(lockPath);
          try {
            unlinkSync(lockPath);
          } catch {
            /* ignore */
          }
        },
      };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw e;
      tryBreakStale(lockPath);
      if (!existsSync(lockPath)) continue;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`docker-int lock timeout: ${lockPath}`);
      }
      await sleep(pollMs);
    }
  }
}

export async function withDockerLock<T>(
  fn: () => Promise<T>,
  lockPath?: string,
): Promise<T> {
  const handle = await acquireDockerLock(lockPath);
  try {
    return await fn();
  } finally {
    handle.release();
  }
}
