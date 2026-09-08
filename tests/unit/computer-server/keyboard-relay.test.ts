import assert from "node:assert/strict";
import { test } from "node:test";
import { KeyboardRelay, keyChord } from "../../../computer-server/src/browser/live-key.ts";

test("native relay preserves chords, Unicode, down/up, and resets every held key", async () => {
  const calls: string[] = [];
  const keyboard = {
    down: async (key: string) => { if (key === "é") throw new Error('Unknown key: "é"'); calls.push(`down:${key}`); },
    up: async (key: string) => { calls.push(`up:${key}`); },
    press: async (key: string) => { calls.push(`press:${key}`); },
    insertText: async (text: string) => { calls.push(`text:${text}`); },
  };
  const relay = new KeyboardRelay(keyboard as never);
  await relay.send({ key: ".", code: "Period", mods: 0, kind: "keyDown" });
  await relay.send({ key: ".", code: "Period", mods: 0, kind: "keyUp" });
  assert.deepEqual(calls, ["down:.", "up:."]);
  calls.length = 0;
  await relay.send({ key: "a", mods: 4, kind: "keyDown" });
  await relay.send({ key: "", mods: 0, kind: "reset" });
  assert.deepEqual(calls, ["down:Control", "down:a", "up:a", "up:Control"]);
  calls.length = 0;
  await relay.send({ key: "@", code: "Digit2", mods: 1, kind: "keyDown" });
  await relay.send({ key: "@", code: "Digit2", mods: 1, kind: "keyUp" });
  await relay.send({ key: "é", code: "KeyE", mods: 0, kind: "keyDown" });
  await relay.send({ key: "Dead", mods: 0, kind: "keyDown" });
  assert.deepEqual(calls, ["down:Alt", "text:@", "up:Alt", "text:é"]);
  assert.equal(keyChord("a", 4), "Control+a");
  assert.equal(keyChord("ArrowLeft", 8), "Shift+ArrowLeft");
});

test("full presses release modifiers and a failed keyup cannot block reset", async () => {
  const calls: string[] = [];
  const relay = new KeyboardRelay({
    down: async (key: string) => { calls.push(`down:${key}`); },
    press: async (key: string) => { calls.push(`press:${key}`); },
    up: async (key: string) => { calls.push(`up:${key}`); throw new Error("Target closed"); },
  } as never);
  await relay.send({ key: "a", mods: 2 });
  assert.deepEqual(calls, ["down:Control", "press:a", "up:Control"]);
  calls.length = 0;
  await relay.reset();
  assert.deepEqual(calls, [], "failed releases do not leave tracked keys stuck");
});
