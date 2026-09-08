import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { acquireDockerLock } from "../../docker-int/lock.ts";

const STALE_AGE_S = 21 * 60;

let dir: string;
let lockPath: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "docker-int-lock-"));
  lockPath = join(dir, ".lock");
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeLock(body: string): void {
  writeFileSync(lockPath, body);
}

test("stale lock with dead pid is broken and acquired immediately", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const deadPid = child.pid;
  assert.ok(deadPid);
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
  });
  writeLock(
    JSON.stringify({
      pid: deadPid,
      host: hostname(),
      created_at: new Date().toISOString(),
    }),
  );
  const t0 = Date.now();
  const handle = await acquireDockerLock(lockPath, {
    timeoutMs: 5_000,
    pollMs: 20,
  });
  const elapsed = Date.now() - t0;
  try {
    assert.ok(elapsed < 1_000, `acquire took ${elapsed}ms`);
    assert.equal(existsSync(lockPath), true);
  } finally {
    handle.release();
  }
  assert.equal(existsSync(lockPath), false);
});

test("live holder blocks until timeout", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const livePid = child.pid;
  assert.ok(livePid);
  try {
    writeLock(
      JSON.stringify({
        pid: livePid,
        host: "test",
        created_at: new Date().toISOString(),
      }),
    );
    await assert.rejects(
      () => acquireDockerLock(lockPath, { timeoutMs: 400, pollMs: 50 }),
      /docker-int lock timeout/,
    );
    assert.equal(existsSync(lockPath), true);
  } finally {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
    });
    try {
      unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
});

test("release unlinks", async () => {
  const handle = await acquireDockerLock(lockPath, {
    timeoutMs: 2_000,
    pollMs: 20,
  });
  assert.equal(existsSync(lockPath), true);
  handle.release();
  assert.equal(existsSync(lockPath), false);
});

test("foreign-host lock with live local pid is respected", async () => {
  writeLock(
    JSON.stringify({
      pid: process.pid,
      host: "other-host.example",
      created_at: new Date().toISOString(),
    }),
  );
  await assert.rejects(
    () => acquireDockerLock(lockPath, { timeoutMs: 400, pollMs: 50 }),
    /docker-int lock timeout/,
  );
  assert.equal(existsSync(lockPath), true);
});

test("malformed lock older than 20 min is broken", async () => {
  writeLock("not-json{{{");
  const old = new Date(Date.now() - STALE_AGE_S * 1000);
  utimesSync(lockPath, old, old);
  const handle = await acquireDockerLock(lockPath, {
    timeoutMs: 2_000,
    pollMs: 20,
  });
  try {
    assert.equal(existsSync(lockPath), true);
  } finally {
    handle.release();
  }
  assert.equal(existsSync(lockPath), false);
});

test("malformed lock younger than 20 min is respected", async () => {
  writeLock("not-json{{{");
  await assert.rejects(
    () => acquireDockerLock(lockPath, { timeoutMs: 400, pollMs: 50 }),
    /docker-int lock timeout/,
  );
  assert.equal(existsSync(lockPath), true);
});
