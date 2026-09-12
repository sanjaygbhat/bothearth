import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveView } from "../../../src/ui/live/session.ts";
import { encodeLiveFrame } from "../../../src/protocol/live.ts";

for (const failure of ["close", "server error", "error during decode"]) test(`${failure}: recovery preserves the last picture, requires fresh authority/frame, and never replays keys`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const originals = { WebSocket: globalThis.WebSocket, location: globalThis.location, createImageBitmap: globalThis.createImageBitmap };
  const sockets: Socket[] = [];
  class Socket extends EventTarget {
    static OPEN = 1; readyState = 1; sent: Array<Record<string, unknown>> = [];
    constructor() { super(); sockets.push(this); }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  const doc = Object.assign(new EventTarget(), { hidden: false, defaultView: new EventTarget() });
  let pixels = false, errors = 0;
  const canvas = Object.assign(new EventTarget(), { ownerDocument: doc, width: 1, height: 1,
    getContext: () => ({ clearRect() { pixels = false; }, drawImage() { pixels = true; } }),
  });
  const banner = { textContent: "", classList: { toggle() {} } };
  let finishDecode: (() => void) | undefined;
  globalThis.createImageBitmap = (() => new Promise((resolve) => {
    finishDecode = () => resolve({ width: 1, height: 1, close() {} } as ImageBitmap);
  })) as typeof createImageBitmap;
  Object.assign(globalThis, { WebSocket: Socket, location: { protocol: "http:", host: "localhost" } });
  const mode = (socket: Socket, epoch: number) => socket.dispatchEvent(new MessageEvent("message", {
    data: JSON.stringify({ v: 1, t: "hello", mode: "human", epoch, viewport: { w: 1, h: 1, dpr: 1 }, session: "fixture" }),
  }));
  const frame = (socket: Socket, epoch: number) => socket.dispatchEvent(new MessageEvent("message", {
    data: encodeLiveFrame({ v: 1, seq: 1, ts: 0, mime: "image/jpeg", mode: "human", epoch, target: "p",
      viewport: { w: 1, h: 1, dpr: 1 }, meta: { offsetTop: 0, pageScaleFactor: 1, deviceWidth: 1, deviceHeight: 1, scrollOffsetX: 0, scrollOffsetY: 0 },
    }, new Uint8Array()).buffer,
  }));
  const key = () => canvas.dispatchEvent(Object.assign(new Event("keydown"), { key: "x", code: "KeyX" }));
  const inputs = (socket: Socket) => socket.sent.filter((m) => m.t === "key" && m.kind !== "reset");
  const view = new LiveView(canvas as unknown as HTMLCanvasElement, banner as unknown as HTMLElement, "fixture", { onError() { errors++; } });
  view.setDriver(true);
  try {
    view.connect(); const first = sockets[0]!;
    assert.equal(view.sendText("blocked"), false);
    mode(first, 8); assert.equal(view.sendText("unseen"), false); key(); assert.equal(inputs(first).length, 0, "hello alone must not enable unseen input");
    frame(first, 8); finishDecode!(); await new Promise(setImmediate);
    assert.equal(pixels, true); key(); assert.equal(inputs(first).length, 1);
    assert.equal(view.sendText("demo.user@example.test · नमस्ते"), true);
    assert.deepEqual(first.sent.find((m) => m.t === "text"), { v: 1, t: "text", epoch: 8, text: "demo.user@example.test · नमस्ते" });
    assert.equal(view.sendText("x".repeat(16385)), false);
    const serverError = (socket: Socket) => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ v: 1, t: "error", code: "E_IO", message: "Synthetic capture failure" }) }));
    if (failure === "server error") serverError(first); else first.close();
    assert.equal(view.sendText("disconnected"), false); assert.equal(pixels, true); assert.match(banner.textContent, /Reconnecting/); assert.equal(errors, 1);
    t.mock.timers.tick(1000);
    const second = sockets[1]!; assert.ok(second); key(); assert.equal(second.sent.length, 0, "old input is not replayed");
    mode(second, 2); key(); assert.equal(inputs(second).length, 0);
    frame(second, 2);
    if (failure === "error during decode") serverError(second);
    else {
      const beforeErrors = errors;
      doc.hidden = true; doc.dispatchEvent(new Event("visibilitychange"));
      assert.equal(second.readyState, 1, "backgrounding must retain the connection");
      assert.equal(errors, beforeErrors, "backgrounding is not a connection failure");
    }
    finishDecode!(); await new Promise(setImmediate); assert.equal(pixels, false, "in-flight HUMAN decode cannot restore a hidden or disconnected screen");
    doc.hidden = false; doc.dispatchEvent(new Event("visibilitychange"));
    if (failure === "error during decode") {
      const third = sockets[2]!; mode(third, 3); frame(third, 3); finishDecode!(); await new Promise(setImmediate);
      key(); assert.equal(inputs(third).length, 1); assert.equal(pixels, true);
      assert.equal(third.sent.some((m) => String(m.t).startsWith("takeover")), false, "recovery never changes the server lease");
      third.close();
      view.close(); assert.equal(pixels, false);
      t.mock.timers.tick(5000);
      doc.dispatchEvent(new Event("visibilitychange")); assert.equal(sockets.length, 3, "leaving the view removes recovery listeners");
    } else {
      assert.equal(sockets.length, 2, "becoming visible must not replace an open socket");
      key(); assert.equal(inputs(second).length, 0, "hidden frames cannot enable input");
      frame(second, 2); finishDecode!(); await new Promise(setImmediate);
      key(); assert.equal(inputs(second).length, 1); assert.equal(pixels, true);
      assert.equal(second.sent.some((m) => String(m.t).startsWith("takeover")), false, "recovery never changes the server lease");
      second.close();
      view.close(); assert.equal(pixels, false);
      t.mock.timers.tick(5000);
      doc.dispatchEvent(new Event("visibilitychange")); assert.equal(sockets.length, 2, "leaving the view removes recovery listeners");
    }
  } finally { view.close(); Object.assign(globalThis, originals); }
});

// Control ownership must not regress when an older frame arrives after grant.
it("stale live frame cannot revoke newer human control", async () => {
  const { LiveView } = await import("../../../src/ui/live/session.ts");
  const { encodeLiveFrame } = await import("../../../src/protocol/live.ts");
  const frame = encodeLiveFrame({ v: 1, seq: 1, ts: 0, mime: "image/jpeg", mode: "agent", epoch: 1, target: "p", viewport: { w: 1, h: 1, dpr: 1 }, meta: { offsetTop: 0, pageScaleFactor: 1, deviceWidth: 1, deviceHeight: 1, scrollOffsetX: 0, scrollOffsetY: 0 } }, new Uint8Array());
  const view = { epoch: 2, mode: "human", authorityKnown: true, ack() {}, drawFrame: () => assert.fail("stale frame painted") };
  await (LiveView.prototype as unknown as { onMessage(data: unknown): Promise<void> }).onMessage.call(view, frame.buffer);
  assert.deepEqual([view.epoch, view.mode], [2, "human"]);
});

it("recreated computer accepts its lower authoritative epoch and rejects old frames", async () => {
  const { LiveView } = await import("../../../src/ui/live/session.ts");
  let painted = 0;
  const view = Object.assign(Object.create(LiveView.prototype), {
    epoch: 8, mode: "agent", cb: {}, authorityKnown: true, clearFrame() {},
    updateBanner() {}, ack() {}, drawFrame: async () => { painted++; },
  });
  await view.onMessage(JSON.stringify({ v: 1, t: "mode", mode: "human", epoch: 2 }));
  assert.deepEqual([view.epoch, view.mode], [2, "human"]);
  const frame = (epoch: number, mode: "agent" | "human") => encodeLiveFrame({
    v: 1, seq: 1, ts: 0, mime: "image/jpeg", mode, epoch, target: "p",
    viewport: { w: 1, h: 1, dpr: 1 },
    meta: { offsetTop: 0, pageScaleFactor: 1, deviceWidth: 1, deviceHeight: 1, scrollOffsetX: 0, scrollOffsetY: 0 },
  }, new Uint8Array()).buffer;
  await view.onMessage(frame(8, "human"));
  await view.onMessage(frame(1, "human"));
  await view.onMessage(frame(2, "agent"));
  assert.equal(painted, 0, "prior computer and wrong-mode frames cannot paint");
  await view.onMessage(frame(2, "human"));
  assert.equal(painted, 1, "current operator frame paints without reloading");
});

it("reconnected live view ignores messages from its old socket", async () => {
  const { LiveView } = await import("../../../src/ui/live/session.ts");
  const originalWs = globalThis.WebSocket;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const sockets: EventTarget[] = [];
  class Socket extends EventTarget {
    binaryType = "";
    constructor() { super(); sockets.push(this); }
    close() {}
  }
  let received = 0;
  try {
    globalThis.WebSocket = Socket as unknown as typeof WebSocket;
    Object.defineProperty(globalThis, "location", { configurable: true, value: { protocol: "http:", host: "localhost" } });
    const view = Object.assign(Object.create(LiveView.prototype), {
      ws: null, objectUrl: null, computerId: "computer", cb: {},
      onMessage: async () => { received++; },
    });
    view.connect(); view.connect();
    sockets[0]!.dispatchEvent(new MessageEvent("message", { data: "old" }));
    assert.equal(received, 0);
    sockets[1]!.dispatchEvent(new MessageEvent("message", { data: "current" }));
    assert.equal(received, 1);
    view.close();
  } finally {
    globalThis.WebSocket = originalWs;
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

it("canvas blur and disconnect reset held operator keys", async () => {
  const { LiveView } = await import("../../../src/ui/live/session.ts");
  const canvas = new EventTarget();
  const sent: Array<{ kind: string }> = [];
  let closed = false;
  const view = new LiveView(canvas as HTMLCanvasElement, { textContent: "", classList: { toggle() {} } } as unknown as HTMLElement, "computer");
  view.setDriver(true);
  Object.assign(view, { mode: "human", authorityKnown: true, ws: { readyState: WebSocket.OPEN, send: (s: string) => sent.push(JSON.parse(s)), close: () => { closed = true; } } });
  canvas.dispatchEvent(new Event("blur"));
  assert.equal(sent[0]?.kind, "reset");
  view.close();
  assert.equal(sent[1]?.kind, "reset");
  assert.equal(closed, true);
});

describe("keys while driving", () => {
  it("keeps Esc and the command keys for the app, and forwards everything else", () => {
    const key = (init: Partial<KeyboardEvent>) => init as unknown as KeyboardEvent;
    assert.equal(LiveView.keepsLocally(key({ key: "Escape" })), false, "Esc reaches the remote computer");
    assert.equal(LiveView.keepsLocally(key({ key: "Enter", metaKey: true })), true, "⌘↩ is ours");
    assert.equal(LiveView.keepsLocally(key({ key: ".", metaKey: true })), true, "⌘. is ours");
    assert.equal(LiveView.keepsLocally(key({ key: "T", ctrlKey: true })), false);
    for (const k of ["a", "Tab", "Enter", "Backspace", "ArrowLeft", "ArrowDown", "Shift"]) {
      assert.equal(LiveView.keepsLocally(key({ key: k })), false, `${k} reaches the website`);
    }
  });

  it("swallows Tab while driving so focus cannot walk out of the screen", () => {
    const UI = join(dirname(fileURLToPath(import.meta.url)), "../../../src/ui");
    const body = readFileSync(join(UI, "live/session.ts"), "utf8");
    const onKey = body.slice(body.indexOf("private onKey("));
    assert.match(onKey, /if \(LiveView\.keepsLocally\(ev\)/);
    // The preventDefault comes AFTER the local-keys check and BEFORE the send,
    // so Tab, the arrows and Backspace never also act on the app's own DOM.
    assert.ok(
      onKey.indexOf("keepsLocally") < onKey.indexOf("ev.preventDefault()"),
      "the app's own keys escape before anything is prevented",
    );
  });
});

describe("driving after a socket drop", () => {
  class Socket extends EventTarget {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = 1;
    sent: Array<Record<string, unknown>> = [];
    send(data: string) {
      this.sent.push(JSON.parse(data) as Record<string, unknown>);
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }

  async function mount(t: { mock: { timers: { enable(opts: { apis: string[] }): void; tick(ms: number): void } } }, driver = true) {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const originals = {
      WebSocket: globalThis.WebSocket,
      location: globalThis.location,
      createImageBitmap: globalThis.createImageBitmap,
    };
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
      style: { cursor: "" },
      getContext: () => ({ clearRect() {}, drawImage() {} }),
    });
    const banner = { textContent: "" };
    const recoveries: Array<{ held: boolean; message: string }> = [];
    globalThis.createImageBitmap = (() =>
      Promise.resolve({ width: 1, height: 1, close() {} })) as typeof createImageBitmap;
    Object.assign(globalThis, { WebSocket: Tracked, location: { protocol: "http:", host: "localhost" } });
    const view = new LiveView(
      canvas as unknown as HTMLCanvasElement,
      banner as unknown as HTMLElement,
      "fixture",
      {
        onError(err, recovery) {
          recoveries.push({ held: recovery?.held === true, message: err.message });
        },
      },
    );
    if (driver) view.setDriver(true);
    view.connect();
    const hello = (socket: Socket, epoch: number, mode: "agent" | "human" = "human") =>
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ v: 1, t: "hello", mode, epoch, viewport: { w: 1, h: 1, dpr: 1 }, session: "fixture" }),
      }));
    const modeMsg = (socket: Socket, epoch: number, mode: "agent" | "human") =>
      socket.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ v: 1, t: "mode", mode, epoch }),
      }));
    const frame = (socket: Socket, epoch: number, mode: "agent" | "human" = "human") =>
      socket.dispatchEvent(new MessageEvent("message", {
        data: encodeLiveFrame({
          v: 1, seq: 1, ts: 0, mime: "image/jpeg", mode, epoch, target: "p",
          viewport: { w: 1, h: 1, dpr: 1 },
          meta: { offsetTop: 0, pageScaleFactor: 1, deviceWidth: 1, deviceHeight: 1, scrollOffsetX: 0, scrollOffsetY: 0 },
        }, new Uint8Array()).buffer,
      }));
    const key = () => canvas.dispatchEvent(Object.assign(new Event("keydown"), { key: "x", code: "KeyX" }));
    const inputs = (socket: Socket) => socket.sent.filter((m) => m.t === "key" && m.kind !== "reset");
    return {
      view, sockets, canvas, banner, recoveries, hello, modeMsg, frame, key, inputs,
      restore() {
        view.close();
        Object.assign(globalThis, originals);
      },
    };
  }

  it("a fresh mode with the same epoch restores frames and input", async (t) => {
    const s = await mount(t);
    try {
      const first = s.sockets[0]!;
      s.modeMsg(first, 4, "human");
      s.frame(first, 4);
      await new Promise(setImmediate);
      s.key();
      assert.equal(s.inputs(first).length, 1);
      first.close();
      t.mock.timers.tick(250);
      const second = s.sockets[1]!;
      assert.ok(second);
      s.key();
      assert.equal(s.inputs(second).length, 0, "reconnect must wait for a fresh mode acknowledgement");
      s.modeMsg(second, 4, "human");
      s.key();
      assert.equal(s.inputs(second).length, 0, "same-epoch mode without a frame must not relay");
      s.frame(second, 4);
      await new Promise(setImmediate);
      s.key();
      assert.equal(s.inputs(second).length, 1);
      assert.equal((s.inputs(second)[0] as { epoch: number }).epoch, 4);
    } finally {
      s.restore();
    }
  });

  it("resumes sending after reconnect without a second acquire", async (t) => {
    const s = await mount(t);
    try {
      const first = s.sockets[0]!;
      s.hello(first, 4);
      s.frame(first, 4);
      await new Promise(setImmediate);
      s.key();
      assert.equal(s.inputs(first).length, 1);
      first.close();
      assert.equal(s.recoveries[0]?.held, true);
      assert.match(s.recoveries[0]!.message, /^Reconnecting/);
      assert.match(s.banner.textContent, /Reconnecting/);
      assert.doesNotMatch(s.recoveries[0]!.message, /Connection interrupted/);
      t.mock.timers.tick(1000);
      const second = s.sockets[1]!;
      assert.ok(second);
      s.key();
      assert.equal(s.inputs(second).length, 0, "must wait for the new epoch and frame");
      s.hello(second, 5);
      s.key();
      assert.equal(s.inputs(second).length, 0, "mode without a human frame must not relay");
      s.frame(second, 5);
      await new Promise(setImmediate);
      s.key();
      assert.equal(s.inputs(second).length, 1);
      assert.equal((s.inputs(second)[0] as { epoch: number }).epoch, 5);
      assert.equal(s.sockets.length, 2);
    } finally {
      s.restore();
    }
  });

  it("applies a mode/epoch change on the open socket", async (t) => {
    const s = await mount(t);
    try {
      const socket = s.sockets[0]!;
      s.hello(socket, 1, "agent");
      s.frame(socket, 1, "agent");
      await new Promise(setImmediate);
      s.key();
      assert.equal(s.inputs(socket).length, 0);
      s.modeMsg(socket, 2, "human");
      s.key();
      assert.equal(s.inputs(socket).length, 0, "human mode without a matching frame must not relay");
      s.frame(socket, 2, "human");
      await new Promise(setImmediate);
      s.key();
      assert.equal(s.inputs(socket).length, 1);
      assert.equal((s.inputs(socket)[0] as { epoch: number }).epoch, 2);
      assert.equal(s.sockets.length, 1, "authority change must not open a new socket");
      s.view.connect();
      assert.equal(s.sockets.length, 1, "connect() must reuse an open socket");
    } finally {
      s.restore();
    }
  });

  it("hides the local cursor only while this window is driving", async (t) => {
    const s = await mount(t, false);
    try {
      const socket = s.sockets[0]!;
      assert.equal(s.canvas.style.cursor, "");
      s.hello(socket, 1, "agent");
      assert.equal(s.canvas.style.cursor, "");
      s.view.setDriver(true);
      assert.equal(s.canvas.style.cursor, "", "agent mode keeps the local pointer");
      s.modeMsg(socket, 2, "human");
      assert.equal(s.canvas.style.cursor, "", "waiting for a picture keeps the local pointer visible");
      s.frame(socket, 2);
      await new Promise(setImmediate);
      assert.equal(s.canvas.style.cursor, "none");
      s.view.setDriver(false);
      assert.equal(s.canvas.style.cursor, "", "an observer must see the local pointer");
      s.view.setDriver(true);
      assert.equal(s.canvas.style.cursor, "none");
      s.modeMsg(socket, 3, "agent");
      assert.equal(s.canvas.style.cursor, "");
    } finally {
      s.restore();
    }
  });
});
