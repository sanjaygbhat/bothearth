import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  STDIO_LIVE_TYPE,
  STDIO_RPC_TYPE,
  decodeStdioBody,
  encodeLiveStdioFrame,
  encodeRpcFrame,
  readStdioFrame,
} from "../../../src/protocol/stdio.ts";
import type { ScreencastFrameHeader } from "../../../src/types/contracts.ts";

function readerFrom(buf: Uint8Array): (n: number) => Uint8Array | null {
  let offset = 0;
  return (n: number) => {
    if (offset + n > buf.byteLength) return null;
    const slice = buf.subarray(offset, offset + n);
    offset += n;
    return slice;
  };
}

describe("computer-server protocol conformance", () => {
  it("RPC frame round-trips", () => {
    const req = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "browser_navigate",
      params: { url: "data:text/html,hi", wait_until: null },
    };
    const frame = encodeRpcFrame(req);
    assert.equal(frame[4], STDIO_RPC_TYPE);
    const decoded = readStdioFrame(readerFrom(frame));
    assert.equal(decoded.type, STDIO_RPC_TYPE);
    if (decoded.type === STDIO_RPC_TYPE) {
      assert.deepEqual(decoded.message, req);
    }
  });

  it("LIVE frame multiplexes on same outer length prefix", () => {
    const header: ScreencastFrameHeader = {
      v: 1,
      seq: 3,
      ts: 1,
      mime: "image/jpeg",
      mode: "agent",
      epoch: 1,
      target: "p0",
      viewport: { w: 800, h: 600, dpr: 1 },
      meta: {
        offsetTop: 0,
        pageScaleFactor: 1,
        deviceWidth: 800,
        deviceHeight: 600,
        scrollOffsetX: 0,
        scrollOffsetY: 10,
      },
    };
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const frame = encodeLiveStdioFrame(header, jpeg);
    assert.equal(frame[4], STDIO_LIVE_TYPE);
    const decoded = readStdioFrame(readerFrom(frame));
    assert.equal(decoded.type, STDIO_LIVE_TYPE);
    if (decoded.type === STDIO_LIVE_TYPE) {
      assert.deepEqual(decoded.header, header);
    }
    // body-only decode
    const body = frame.subarray(4);
    const d2 = decodeStdioBody(body);
    assert.equal(d2.type, STDIO_LIVE_TYPE);
  });
});
