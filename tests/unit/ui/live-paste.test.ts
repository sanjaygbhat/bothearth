/**
 * ⌘V while you drive. A password manager is unusable if the only way in is to
 * type the password by hand, so the canvas reads the clipboard and sends it as
 * text — through the async API, or through the paste event when that is denied.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
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

/** A driving LiveView with one socket, one painted frame, and human control. */
async function driving(clipboard: unknown): Promise<{
  canvas: EventTarget & { fire(type: string, event?: Record<string, unknown>): void };
  socket: Socket;
  text: () => string[];
  restore: () => void;
}> {
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = {
    WebSocket: globals.WebSocket,
    location: globals.location,
    createImageBitmap: globals.createImageBitmap,
  };
  // Node's own `navigator` is a getter-only accessor on globalThis.
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
  globals.WebSocket = Tracked;
  globals.location = { protocol: "http:", host: "localhost" };
  globals.createImageBitmap = () => Promise.resolve({ width: 1, height: 1, close() {} });
  Object.defineProperty(globalThis, "navigator", { value: { clipboard }, configurable: true });

  const view = new LiveView(
    canvas as unknown as HTMLCanvasElement,
    { textContent: "" } as unknown as HTMLElement,
    "cmp_1",
  );
  // This page holds the grant; an observer window relays nothing.
  view.setDriver(true);
  view.connect();
  const socket = sockets[0]!;
  socket.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({
        v: 1,
        t: "hello",
        mode: "human",
        epoch: 1,
        viewport: { w: 1, h: 1, dpr: 1 },
        session: "fixture",
      }),
    }),
  );
  socket.dispatchEvent(
    new MessageEvent("message", {
      data: encodeLiveFrame(
        {
          v: 1, seq: 1, ts: 0, mime: "image/jpeg", mode: "human", epoch: 1, target: "p",
          viewport: { w: 1, h: 1, dpr: 1 },
          meta: { offsetTop: 0, pageScaleFactor: 1, deviceWidth: 1, deviceHeight: 1, scrollOffsetX: 0, scrollOffsetY: 0 },
        },
        new Uint8Array(),
      ).buffer,
    }),
  );
  await new Promise(setImmediate);
  return {
    canvas: canvas as never,
    socket,
    text: () => socket.sent.filter((m) => m.t === "text").map((m) => String(m.text)),
    restore: () => {
      view.close();
      Object.assign(globals, saved);
      if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);
    },
  };
}

describe("pasting into the live screen", () => {
  it("sends what navigator.clipboard holds, and never the keystroke", async () => {
    const t = await driving({ readText: async () => "hunter2 · пароль" });
    try {
      t.canvas.fire("keydown", { key: "v", code: "KeyV", metaKey: true });
      await new Promise(setImmediate);
      assert.deepEqual(t.text(), ["hunter2 · пароль"]);
      assert.equal(
        t.socket.sent.some((m) => m.t === "key" && m.key === "v"),
        false,
        "⌘V is a paste, not a keystroke for the remote page",
      );
    } finally {
      t.restore();
    }
  });

  it("falls back to the paste event when the async clipboard is denied", async () => {
    const t = await driving({
      readText: () => Promise.reject(new Error("NotAllowedError")),
    });
    try {
      t.canvas.fire("keydown", { key: "V", code: "KeyV", ctrlKey: true });
      t.canvas.fire("paste", {
        clipboardData: { getData: (type: string) => (type === "text/plain" ? "from the event" : "") },
      });
      await new Promise(setImmediate);
      assert.deepEqual(t.text(), ["from the event"]);
    } finally {
      t.restore();
    }
  });

  it("works with no async clipboard at all, and sends one paste per keystroke", async () => {
    const t = await driving({});
    try {
      t.canvas.fire("keydown", { key: "v", code: "KeyV", metaKey: true });
      t.canvas.fire("paste", {
        clipboardData: { getData: () => "once" },
      });
      t.canvas.fire("paste", {
        clipboardData: { getData: () => "twice" },
      });
      await new Promise(setImmediate);
      assert.deepEqual(t.text(), ["once"]);
    } finally {
      t.restore();
    }
  });

  it("ignores a paste nobody asked for", async () => {
    const t = await driving({ readText: async () => "never read" });
    try {
      t.canvas.fire("paste", { clipboardData: { getData: () => "unsolicited" } });
      await new Promise(setImmediate);
      assert.deepEqual(t.text(), []);
    } finally {
      t.restore();
    }
  });
});
