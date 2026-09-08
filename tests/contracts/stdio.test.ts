import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeStdioBody,
  encodeLiveStdioFrame,
  encodeRpcFrame,
  JSON_RPC_ERROR,
  jsonRpcTransportError,
  MAX_STDIO_BODY_BYTES,
  readStdioFrame,
  STDIO_LIVE_TYPE,
  STDIO_RPC_TYPE,
} from "../../src/protocol/stdio.ts";
import type { ScreencastFrameHeader } from "../../src/types/contracts.ts";
import { readerFrom } from "../helpers/stdio.ts";

describe("stdio JSON-RPC framing", () => {
  it("length-prefixes RPC: u32 BE + type 0 + utf8 JSON", () => {
    const req = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "browser_snapshot",
      params: {},
    };
    const frame = encodeRpcFrame(req);
    const bodyLen = new DataView(
      frame.buffer,
      frame.byteOffset,
      frame.byteLength,
    ).getUint32(0, false);
    assert.equal(bodyLen, frame.byteLength - 4);
    assert.equal(frame[4], STDIO_RPC_TYPE);

    const decoded = readStdioFrame(readerFrom(frame));
    assert.equal(decoded.type, STDIO_RPC_TYPE);
    if (decoded.type === STDIO_RPC_TYPE) {
      assert.deepEqual(decoded.message, req);
    }
  });

  it("multiplexes LIVE with same outer length prefix", () => {
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
      assert.deepEqual(Buffer.from(decoded.payload), Buffer.from(jpeg));
    }
  });

  it("rejects oversize body_len; transport error codes; unknown type", () => {
    const huge = new Uint8Array(4);
    new DataView(huge.buffer).setUint32(0, MAX_STDIO_BODY_BYTES + 1, false);
    assert.throws(() => readStdioFrame(readerFrom(huge)), /MAX_STDIO_BODY_BYTES/);

    const err = jsonRpcTransportError(7, JSON_RPC_ERROR.TIMEOUT, "timed out");
    assert.equal(err.error?.code, -32002);
    assert.equal(err.id, 7);

    assert.throws(
      () => decodeStdioBody(Uint8Array.from([9])),
      /unknown stdio frame type/,
    );
  });
});
