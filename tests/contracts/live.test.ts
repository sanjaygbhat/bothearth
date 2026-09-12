import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeControlMessage,
  decodeLiveFrame,
  encodeControlMessage,
  encodeLiveFrame,
  liveRelayMethod,
  LIVE_FRAME_TYPE,
} from "../../src/protocol/live.ts";
import type { ScreencastFrameHeader } from "../../src/types/contracts.ts";

describe("live-view frame header", () => {
  it("round-trips encode→decode with golden bytes", () => {
    const header: ScreencastFrameHeader = {
      v: 1,
      seq: 81,
      ts: 1756800000000,
      mime: "image/jpeg",
      mode: "agent",
      epoch: 2,
      target: "p1",
      viewport: { w: 1280, h: 720, dpr: 1 },
      meta: {
        offsetTop: 0,
        pageScaleFactor: 1,
        deviceWidth: 1280,
        deviceHeight: 720,
        scrollOffsetX: 0,
        scrollOffsetY: 1840,
      },
    };
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const encoded = encodeLiveFrame(header, jpeg);
    assert.equal(encoded[0], LIVE_FRAME_TYPE);

    const headerBytes = new TextEncoder().encode(JSON.stringify(header));
    const golden = new Uint8Array(1 + 4 + headerBytes.length + jpeg.length);
    golden[0] = 1;
    new DataView(golden.buffer).setUint32(1, headerBytes.length, false);
    golden.set(headerBytes, 5);
    golden.set(jpeg, 5 + headerBytes.length);
    assert.deepEqual(Buffer.from(encoded), Buffer.from(golden));

    const decoded = decodeLiveFrame(encoded);
    assert.deepEqual(decoded.header, header);
    assert.deepEqual(Buffer.from(decoded.payload), Buffer.from(jpeg));
  });

  it("encodes/decodes control messages", () => {
    const msg = {
      v: 1 as const,
      t: "pointer" as const,
      epoch: 8,
      kind: "down" as const,
      x: 412,
      y: 233,
      button: 0,
      buttons: 1,
      mods: 0,
    };
    const raw = encodeControlMessage(msg);
    assert.deepEqual(decodeControlMessage(raw), msg);
    const producer = { v: 1 as const, t: "producer" as const, status: "failed" as const, reason: "exit 1" };
    assert.deepEqual(decodeControlMessage(encodeControlMessage(producer)), producer);
  });

  it("liveRelayMethod maps UI t=key|text|pointer (not type)", async () => {
    assert.equal(liveRelayMethod({ t: "key", key: "Enter" }), "live.key");
    assert.equal(liveRelayMethod({ t: "text", text: "hi" }), "live.text");
    assert.equal(liveRelayMethod({ t: "pointer", kind: "down", x: 1, y: 2 }), "live.pointer");
    assert.equal(liveRelayMethod({ type: "live.text", text: "x" }), "live.text");
    assert.equal(liveRelayMethod({}), "live.pointer");
  });
});
