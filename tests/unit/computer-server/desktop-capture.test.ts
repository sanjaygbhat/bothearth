import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { ChildProcess } from "node:child_process";
import { Desktop } from "../../../computer-server/src/browser/desktop.ts";

function fakeCapture(): ChildProcess {
  const stdout = new PassThrough();
  const child = new EventEmitter() as ChildProcess;
  let dead = false;
  Object.assign(child, {
    stdout,
    exitCode: null,
    kill() {
      if (dead) return true;
      dead = true;
      child.exitCode = 1;
      stdout.end();
      child.emit("exit", 1, null);
      return true;
    },
  });
  return child;
}

test("a capture child exit restarts and delivers the next JPEG", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const desktop = new Desktop("/tmp/unused-desktop-capture");
  const children: ChildProcess[] = [];
  const frames: Uint8Array[] = [];
  const status: Array<{ status: string; reason: string }> = [];
  t.mock.method(desktop as unknown as { spawn(command: string, args: string[]): ChildProcess }, "spawn", (command: string, args: string[]) => {
    assert.equal(command, "ffmpeg");
    assert.equal(args.includes("x11grab"), true);
    const child = fakeCapture();
    children.push(child);
    return child;
  });
  t.after(() => desktop.close());
  desktop.stream(jpeg => frames.push(jpeg), (state, reason) => status.push({ status: state, reason }));
  assert.equal(children.length, 1);
  children[0]!.emit("exit", 1, null);
  assert.deepEqual(status, [{ status: "restarting", reason: "exit 1" }]);
  t.mock.timers.tick(250);
  assert.equal(children.length, 2);
  (children[1]!.stdout as PassThrough).write(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]![0], 0xff);
  assert.equal(frames[0]![1], 0xd8);
});

test("a silent capture fails after three restarts instead of waiting forever", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const desktop = new Desktop("/tmp/unused-desktop-capture-timeout");
  const children: ChildProcess[] = [];
  const status: string[] = [];
  t.mock.method(desktop as unknown as { spawn(): ChildProcess }, "spawn", () => {
    const child = fakeCapture();
    children.push(child);
    return child;
  });
  t.after(() => desktop.close());
  desktop.stream(() => {}, (state) => status.push(state));
  t.mock.timers.tick(3000);
  t.mock.timers.tick(250);
  t.mock.timers.tick(3000);
  t.mock.timers.tick(500);
  t.mock.timers.tick(3000);
  t.mock.timers.tick(1000);
  t.mock.timers.tick(3000);
  assert.equal(children.length, 4);
  assert.deepEqual(status, ["restarting", "restarting", "restarting", "failed"]);
});

test("stopping the stream cancels a pending capture restart", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const desktop = new Desktop("/tmp/unused-desktop-capture-stop");
  let spawns = 0;
  t.mock.method(desktop as unknown as { spawn(): ChildProcess }, "spawn", () => {
    spawns++;
    return fakeCapture();
  });
  t.after(() => desktop.close());
  desktop.stream(() => {}, () => {});
  assert.equal(spawns, 1);
  desktop.stopStream();
  t.mock.timers.tick(3000);
  t.mock.timers.tick(1000);
  assert.equal(spawns, 1);
});
