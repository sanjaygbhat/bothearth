/**
 * ⌘V is a paste only while the person holds control. With the bot driving, the
 * canvas still has focus, and reading the clipboard there would raise the
 * browser's clipboard permission prompt over a screen the person is only
 * watching — and would read their clipboard for a paste that can never be sent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveView } from "../../../src/ui/live/session.ts";
import { encodeLiveFrame } from "../../../src/protocol/live.ts";

class Socket extends EventTarget {
  static OPEN = 1;
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
}

/**
 * A connected, painted LiveView in the mode the daemon reported. `driver` is
 * false in a window that is watching someone else drive: the daemon reports
 * `human` to every window, and only the holder's may send.
 */
async function watching(mode: "agent" | "human", driver = true): Promise<{
  canvas: { fire(type: string, event?: Record<string, unknown>): void };
  socket: Socket;
  reads: () => number;
  restore: () => void;
}> {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = { WebSocket: globals.WebSocket, location: globals.location, createImageBitmap: globals.createImageBitmap };
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const sockets: Socket[] = [];
  class Tracked extends Socket {
    constructor() {
      super();
      sockets.push(this);
    }
  }
  const doc = Object.assign(new EventTarget(), { hidden: false, defaultView: new EventTarget() });
  const canvas = Object.assign(new EventTarget(), {
    ownerDocument: doc,
    width: 1,
    height: 1,
    getContext: () => ({ clearRect() {}, drawImage() {} }),
    fire(type: string, event: Record<string, unknown> = {}) {
      this.dispatchEvent(Object.assign(new Event(type), { preventDefault() {} }, event));
    },
  });
  let reads = 0;
  globals.WebSocket = Tracked;
  globals.location = { protocol: "http:", host: "localhost" };
  globals.createImageBitmap = () => Promise.resolve({ width: 1, height: 1, close() {} });
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { readText: async () => { reads++; return "a password"; } } },
    configurable: true,
  });

  const view = new LiveView(
    canvas as unknown as HTMLCanvasElement,
    { textContent: "" } as unknown as HTMLElement,
    "cmp_1",
  );
  view.setDriver(driver);
  view.connect();
  const socket = sockets[0]!;
  const hello = { v: 1, t: "hello", mode, epoch: 1, viewport: { w: 1, h: 1, dpr: 1 }, session: "fixture" };
  socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(hello) }));
  socket.dispatchEvent(new MessageEvent("message", {
    data: encodeLiveFrame(
      {
        v: 1, seq: 1, ts: 0, mime: "image/jpeg", mode, epoch: 1, target: "p",
        viewport: { w: 1, h: 1, dpr: 1 },
        meta: { offsetTop: 0, pageScaleFactor: 1, deviceWidth: 1, deviceHeight: 1, scrollOffsetX: 0, scrollOffsetY: 0 },
      },
      new Uint8Array(),
    ).buffer,
  }));
  await new Promise(setImmediate);
  return {
    canvas: canvas as never,
    socket,
    reads: () => reads,
    restore: () => {
      view.close();
      Object.assign(globals, saved);
      if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);
    },
  };
}

test("⌘V while the bot is driving never touches the clipboard", async () => {
  const t = await watching("agent");
  try {
    t.canvas.fire("keydown", { key: "v", code: "KeyV", metaKey: true });
    t.canvas.fire("paste", { clipboardData: { getData: () => "a password" } });
    await new Promise(setImmediate);
    assert.equal(t.reads(), 0, "the clipboard was read while the person was only watching");
    assert.deepEqual(t.socket.sent.filter((m) => m.t === "text"), []);
  } finally {
    t.restore();
  }
});

test("the same keystroke pastes once the person has control", async () => {
  const t = await watching("human");
  try {
    t.canvas.fire("keydown", { key: "v", code: "KeyV", metaKey: true });
    await new Promise(setImmediate);
    assert.equal(t.reads(), 1);
    assert.deepEqual(t.socket.sent.filter((m) => m.t === "text").map((m) => m.text), ["a password"]);
  } finally {
    t.restore();
  }
});

test("a window that did not take control relays nothing while someone else drives", async () => {
  const t = await watching("human", false);
  try {
    t.canvas.fire("keydown", { key: "a", code: "KeyA" });
    t.canvas.fire("keydown", { key: "v", code: "KeyV", metaKey: true });
    t.canvas.fire("paste", { clipboardData: { getData: () => "a password" } });
    await new Promise(setImmediate);
    assert.equal(t.reads(), 0, "an observer must not be asked for its clipboard");
    assert.deepEqual(t.socket.sent.filter((m) => m.t === "key" || m.t === "text"), []);
  } finally {
    t.restore();
  }
});
