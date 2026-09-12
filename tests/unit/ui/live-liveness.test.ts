import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { LiveView } from "../../../src/ui/live/session.ts";
import { encodeLiveFrame } from "../../../src/protocol/live.ts";

async function mount(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 1000 });
  const original = { WebSocket: globalThis.WebSocket, location: globalThis.location, createImageBitmap: globalThis.createImageBitmap };
  const sockets: Socket[] = [];
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    sent: Array<Record<string, unknown>> = [];
    constructor() { super(); sockets.push(this); }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  }
  let pixels = false, inputs = 0;
  const errors: string[] = [];
  const doc = Object.assign(new EventTarget(), { hidden: false, defaultView: new EventTarget() });
  const canvas = Object.assign(new EventTarget(), { ownerDocument: doc, width: 100, height: 100, style: { cursor: "" },
    getContext: () => ({ clearRect() { pixels = false; }, drawImage() { pixels = true; } }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  });
  Object.assign(globalThis, { WebSocket: Socket, location: { protocol: "http:", host: "localhost" },
    createImageBitmap: async () => ({ width: 100, height: 100, close() {} }),
  });
  const view = new LiveView(canvas as unknown as HTMLCanvasElement, { textContent: "" } as HTMLElement, "fixture",
    { onError(error) { errors.push(error.message); }, onInput() { inputs++; } });
  t.after(() => { view.close(); Object.assign(globalThis, original); });
  const control = (msg: object, socket = sockets.at(-1)!) => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ v: 1, ...msg }) }));
  const frame = async (epoch = 2, mode: "human" | "validating" = "human") => {
    sockets.at(-1)!.dispatchEvent(new MessageEvent("message", { data: encodeLiveFrame({ v: 1, seq: 1, ts: Date.now(), mime: "image/jpeg", mode, epoch, target: "desktop",
      viewport: { w: 100, h: 100, dpr: 1 }, meta: { offsetTop: 0, pageScaleFactor: 1, deviceWidth: 100, deviceHeight: 100, scrollOffsetX: 0, scrollOffsetY: 0 } }, new Uint8Array()).buffer }));
    await new Promise(setImmediate);
  };
  const move = (x: number) => canvas.dispatchEvent(Object.assign(new Event("pointermove"), { clientX: x, clientY: 20, buttons: 0 }));
  view.setDriver(true); view.connect(); control({ t: "mode", mode: "human", epoch: 2 }); await frame();
  return { view, sockets, control, frame, move, canvas, errors, pixels: () => pixels, inputs: () => inputs };
}

for (const epoch of [2, 3]) test(`reconnect restores only the last pointer in the same grant (epoch ${epoch})`, async t => {
  const f = await mount(t);
  f.move(10); f.sockets[0]!.close();
  assert.equal(f.pixels(), true, "transport loss keeps the labelled last frame");
  f.move(30); f.move(50);
  assert.equal(f.view.sendText("never replay"), false);
  t.mock.timers.tick(1000);
  f.control({ t: "mode", mode: "human", epoch });
  const socket = f.sockets.at(-1)!;
  assert.equal(socket.sent.filter(m => m.t === "pointer").length, 0, "wait for a fresh picture");
  await f.frame(epoch);
  assert.deepEqual(socket.sent.filter(m => m.t === "pointer").map(m => [m.x, m.kind, m.epoch]), epoch === 2 ? [[50, "move", 2]] : []);
  assert.equal(socket.sent.some(m => m.t === "text"), false);
});

test("a silent open socket is detected and retried without a new grant", async t => {
  const f = await mount(t);
  for (let i = 0; i < 5; i++) t.mock.timers.tick(500);
  assert.equal(f.sockets[0]!.readyState, 3);
  assert.equal(f.sockets.length, 2);
  assert.match(f.errors[0]!, /Reconnecting/);
  assert.equal(f.sockets.some(s => s.sent.some(m => String(m.t).startsWith("takeover"))), false);
});

test("input feedback waits for computer acknowledgement", async t => {
  const f = await mount(t);
  f.move(10); assert.equal(f.inputs(), 0);
  f.control({ t: "input_ack", epoch: 1 }); assert.equal(f.inputs(), 0);
  f.control({ t: "input_ack", epoch: 2 }); assert.equal(f.inputs(), 1);
});

test("the latest input_ack expiry is the lease deadline the page can read", async t => {
  const f = await mount(t);
  assert.equal(f.view.leaseExpiresAt(), null);
  assert.equal(f.view.leaseSeenAt(), null);
  f.control({ t: "mode", mode: "human", epoch: 2, expires_at: new Date(5000).toISOString() });
  assert.equal(f.view.leaseExpiresAt(), 5000);
  assert.equal(f.view.leaseSeenAt(), 1000);
  t.mock.timers.tick(500);
  f.control({ t: "pong" });
  f.control({ t: "input_ack", epoch: 2, expires_at: new Date(9000).toISOString() });
  assert.equal(f.view.leaseExpiresAt(), 9000);
  assert.equal(f.view.leaseSeenAt(), 1500);
  assert.equal(f.inputs(), 1);
});

test("stalled pictures suspend input without reconnecting a responsive socket", async t => {
  const f = await mount(t);
  for (let i = 0; i < 5; i++) { f.control({ t: "pong" }); t.mock.timers.tick(500); }
  assert.equal(f.sockets.length, 1);
  assert.match(f.errors[0]!, /picture/i);
  assert.ok(f.sockets[0]!.sent.some(m => m.t === "key" && m.kind === "reset"));
  f.move(70);
  assert.equal(f.sockets[0]!.sent.some(m => m.t === "pointer"), false);
  await f.frame();
  assert.equal(f.sockets[0]!.sent.find(m => m.t === "pointer")?.x, 70);
});

test("paused and expired control clear private pixels and reject frames", async t => {
  const f = await mount(t);
  f.control({ t: "mode", mode: "human", epoch: 2, expires_at: new Date(1500).toISOString() });
  f.control({ t: "pong" }); t.mock.timers.tick(500);
  assert.equal(f.pixels(), false);
  await f.frame(); assert.equal(f.pixels(), false, "expired human frame stays private");
  f.control({ t: "mode", mode: "validating", epoch: 2 });
  await f.frame(2, "validating"); assert.equal(f.pixels(), false);
});

test("private pixels expire even while every reconnect fails", async t => {
  const f = await mount(t);
  f.control({ t: "mode", mode: "human", epoch: 2, expires_at: new Date(1400).toISOString() });
  f.sockets[0]!.close();
  assert.equal(f.pixels(), true);
  t.mock.timers.tick(250);
  f.sockets.at(-1)!.close();
  t.mock.timers.tick(150);
  assert.equal(f.pixels(), false);
});

test("a dead picture producer restarts without dropping the grant", async t => {
  const f = await mount(t);
  f.control({ t: "producer", status: "restarting" });
  assert.match(f.errors[0]!, /Restarting the picture/);
  assert.equal(f.sockets.length, 1);
  f.move(70);
  assert.equal(f.sockets[0]!.sent.some(m => m.t === "pointer"), false);
  for (let i = 0; i < 5; i++) { f.control({ t: "pong" }); t.mock.timers.tick(500); }
  assert.equal(f.sockets.length, 1);
  assert.equal(f.errors.some(e => /paused/i.test(e)), false);
  await f.frame();
  assert.equal(f.sockets[0]!.sent.find(m => m.t === "pointer")?.x, 70);
});

test("a failed picture producer keeps the grant and names the recovery", async t => {
  const f = await mount(t);
  f.control({ t: "producer", status: "failed", reason: "first frame timed out" });
  assert.match(f.errors[0]!, /Give control back and take it again/);
  assert.equal(f.sockets.length, 1);
  f.move(70);
  assert.equal(f.sockets[0]!.sent.some(m => m.t === "pointer"), false);
});

test("a new grant cannot replay coordinates measured against the previous viewport", async t => {
  const f = await mount(t);
  f.control({ t: "mode", mode: "human", epoch: 3 });
  f.move(80);
  await f.frame(3);
  assert.equal(f.sockets[0]!.sent.some(m => m.t === "pointer"), false);
  f.move(80);
  assert.equal(f.sockets[0]!.sent.filter(m => m.t === "pointer").length, 1);
});
