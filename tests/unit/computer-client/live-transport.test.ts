import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ExecComputerClient } from "../../../src/computer-client/exec-client.ts";
import type { LiveFrameEvent } from "../../../src/computer-client/types.ts";
import { decodeStdioBody, encodeLiveStdioFrame, encodeRpcFrame } from "../../../src/protocol/stdio.ts";
import type { ScreencastFrameHeader } from "../../../src/types/contracts.ts";

/** Model EOF/exit as well as pipes; an EventEmitter alone never exits. */
function fakeExec(stdout: PassThrough, stdin: Writable): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const exit = () => {
    if (child.exitCode !== null) return;
    Object.assign(child, { exitCode: 0 });
    stdout.end();
    child.emit("exit", 0, null);
  };
  Object.assign(child, { stdout, stdin, exitCode: null, kill() { exit(); return true; } });
  stdin.once("finish", exit);
  stdout.once("end", exit);
  return child;
}

test("multiplexed operator frames arrive separately from RPC results and stop on unsubscribe", async () => {
  const stdout = new PassThrough();
  const methods: string[] = [];
  const header = JSON.parse(readFileSync(new URL("../../fixtures/golden/frame-header.json", import.meta.url), "utf8")) as ScreencastFrameHeader;
  header.mode = "human";
  const bytes = new Uint8Array([1, 2, 3]);
  let opens = 0;
  let failSubscription = false;
  const child = fakeExec(stdout, new Writable({ write(chunk, _encoding, callback) {
      const frame = decodeStdioBody(chunk.subarray(4));
      assert.equal(frame.type, 0);
      const request = frame.message as { id: number; method: string };
      methods.push(request.method);
      const refused = request.method === "screencast.subscribe" && failSubscription;
      if (request.method === "screencast.subscribe" && !refused) stdout.write(encodeLiveStdioFrame(header, bytes));
      stdout.write(encodeRpcFrame({ jsonrpc: "2.0", id: request.id, result: refused
        ? { ok: false, error: { code: "E_IO", message: "capture unavailable" } }
        : { ok: true, data: { method: request.method } } }));
      callback();
    }}));
  const client = new ExecComputerClient("live_transport", {
    capabilities: ["browser"],
    cli: { binary: "fixture", run: async () => "", runSync: () => "", spawn: () => { opens++; return child; } },
  });
  const frames: LiveFrameEvent[] = [];
  client.on("frame", (event) => frames.push(event));
  try {
    const next = once(client, "frame");
    client.startLive();
    const result = await client.call("takeover_status");
    await next;
    assert.equal(opens, 1, "concurrent live/tool operations share one browser process");
    assert.deepEqual(result, { ok: true, data: { method: "takeover_status" } });
    assert.equal(frames[0]!.header.mode, "human");
    assert.deepEqual(frames[0]!.payload, bytes);
    client.stopLive();
    stdout.write(encodeLiveStdioFrame(header, bytes));
    await client.call("takeover_status");
    assert.equal(frames.length, 1, "in-flight frames discarded after last subscriber leaves");
    assert.ok(methods.includes("screencast.unsubscribe"));
    failSubscription = true;
    const failure = once(client, "mode");
    client.startLive();
    assert.match(JSON.stringify(await failure), /capture unavailable/);
  } finally { await client.close(); }
});


test("a dead RPC is replaced on the next call without replaying the failed action", async () => {
  let opens = 0;
  const methods: string[] = [];
  const client = new ExecComputerClient("reconnect_transport", {
    capabilities: ["browser"],
    cli: { binary: "fixture", run: async () => "", runSync: () => "", spawn: () => {
      const attempt = ++opens;
      const stdout = new PassThrough();
      const child = fakeExec(stdout, new Writable({ write(chunk, _encoding, callback) {
          const frame = decodeStdioBody(chunk.subarray(4));
          assert.equal(frame.type, 0);
          const request = frame.message as { id: number; method: string };
          methods.push(request.method);
          if (attempt === 1 && request.method === "browser_click") stdout.end();
          else stdout.write(encodeRpcFrame({ jsonrpc: "2.0", id: request.id,
            result: { ok: true, data: { method: request.method } } }));
          callback();
        }}));
      return child;
    } },
  });
  try {
    client.startLive();
    await client.call("takeover_status");
    const failed = await client.call("browser_click", { ref: "synthetic" });
    assert.equal(failed.ok, false);
    assert.equal(opens, 1);
    assert.equal(methods.filter((method) => method === "browser_click").length, 1, "uncertain action was not replayed");
    const [first, second] = await Promise.all([client.call("browser_tabs", { action: "list" }), client.call("takeover_status")]);
    assert.equal(first.ok, true); assert.equal(second.ok, true);
    assert.equal(opens, 2, "concurrent next calls share one replacement");
    assert.equal(methods.filter((method) => method === "screencast.subscribe").length, 2, "live view resubscribes once on replacement");
    assert.equal(methods.filter((method) => method === "browser_click").length, 1);
    assert.ok(methods.includes("browser_tabs"));
  } finally { await client.close(); }
});
