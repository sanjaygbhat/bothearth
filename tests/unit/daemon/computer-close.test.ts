/**
 * Shutting a computer down used to SIGTERM the `docker exec` CLI in the same
 * turn as `stdin.end()`, so the computer-server never got to close Chromium and
 * the profile lost its cookies and kept its lock (`w8-profile-locks.md`).
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { createJsonRpcClient } from "../../../src/sandbox/client.ts";

/** A `docker exec` CLI: it exits `afterEof` ms after stdin closes, or never. */
function fakeExec(afterEof: number | null) {
  const child = new EventEmitter() as unknown as ChildProcess & { kills: string[] };
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  // A real child has a referenced process handle until exit. The fake needs
  // the same lifetime while production's shutdown timers remain unref'ed.
  const lifetime = setInterval(() => {}, 1_000);
  Object.assign(child, {
    exitCode: null,
    signalCode: null,
    kills: [] as string[],
    kill(signal?: NodeJS.Signals) {
      child.kills.push(signal ?? "SIGTERM");
      if (signal === "SIGKILL") exit(null, "SIGKILL");
      return true;
    },
  });
  const exit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (child.exitCode != null || child.signalCode != null) return;
    clearInterval(lifetime);
    Object.assign(child, { exitCode: code, signalCode: signal });
    stdout.end();
    child.emit("exit", code, signal);
  };
  stdin.on("finish", () => {
    if (afterEof !== null) setTimeout(() => exit(0, null), afterEof).unref();
  });
  return { child, stdin, stdout };
}

describe("closing a computer", () => {
  it("waits for the computer-server to shut its browser down before killing the exec", async () => {
    const { child, stdin, stdout } = fakeExec(120);
    const client = createJsonRpcClient(stdin, stdout, child);
    const started = Date.now();
    await client.close();
    assert.deepEqual(child.kills, [], "the exec was killed while the browser was still closing");
    assert.equal(child.exitCode, 0, "close() returned before the computer-server had exited");
    assert.ok(Date.now() - started >= 100, "close() did not wait for the shutdown it asked for");
  });

  it("does not hang on a computer-server that never exits", async () => {
    const { child, stdin, stdout } = fakeExec(null);
    const client = createJsonRpcClient(stdin, stdout, child);
    const started = Date.now();
    await client.close(150);
    assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"], "a stuck exec was left running");
    assert.ok(Date.now() - started >= 150, "the grace period was not honoured");
    assert.ok(Date.now() - started < 5_000, "close() waited far longer than the grace it was given");
  });
});
