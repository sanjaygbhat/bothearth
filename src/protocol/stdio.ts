import type {
  ComputerJsonRpcRequest,
  ComputerJsonRpcResponse,
  ScreencastFrameHeader,
} from "../types/contracts.ts";
import {
  decodeLiveFrame,
  encodeLiveFrame,
  LIVE_FRAME_TYPE,
} from "./live.ts";

/**
 * Daemon ↔ computer-server stdio multiplex (ARCH §5).
 *
 * Stream = sequence of length-prefixed bodies (NOT newline-delimited JSON):
 *
 *   [u32 BE body_len][body…]
 *
 * `body_len` = byte length of `body` only (excludes the 4-byte length field).
 * Endianness: big-endian. Cap: body_len ≤ MAX_STDIO_BODY_BYTES.
 *
 * Body by leading type byte:
 *   0 RPC  — [u8=0][utf8 JSON-RPC 2.0 request|response|notification]
 *   1 LIVE — same bytes as encodeLiveFrame ( [u8=1][u32 BE hdrLen][hdr JSON][image] )
 *
 * Shell role: type 1 forbidden (protocol error → close).
 * Browser: RPC + LIVE on one exec stream (second exec may be RPC-only).
 *
 * Framing/oversize/unknown-type failures are transport errors (close session).
 * They are never ToolResult ErrorCode values.
 *
 * JSON-RPC error.code (transport only):
 *   -32700 parse, -32600 invalid request, -32601 method not found,
 *   -32602 invalid params, -32603 internal,
 *   -32001 sandbox dead, -32002 timeout, -32003 frame/json limit
 * Application ErrorCode ALWAYS inside result as ToolResult {ok:false,error:{code,…}}.
 */

export const STDIO_RPC_TYPE = 0 as const;
export const STDIO_LIVE_TYPE = LIVE_FRAME_TYPE;

/** Max bytes after the u32 length field (type + payload). */
export const MAX_STDIO_BODY_BYTES = 8 * 1024 * 1024;

/** Max UTF-8 JSON-RPC object size (body_len − 1). */
export const MAX_RPC_JSON_BYTES = 2 * 1024 * 1024;

export const JSON_RPC_ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  SANDBOX_DEAD: -32001,
  TIMEOUT: -32002,
  LIMIT: -32003,
} as const;

export type JsonRpcTransportCode =
  (typeof JSON_RPC_ERROR)[keyof typeof JSON_RPC_ERROR];

export function encodeStdioBody(body: Uint8Array): Uint8Array {
  if (body.byteLength > MAX_STDIO_BODY_BYTES) {
    throw new Error(`stdio body exceeds MAX_STDIO_BODY_BYTES (${MAX_STDIO_BODY_BYTES})`);
  }
  const out = new Uint8Array(4 + body.byteLength);
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(
    0,
    body.byteLength,
    false,
  );
  out.set(body, 4);
  return out;
}

export function encodeRpcFrame(
  message: ComputerJsonRpcRequest | ComputerJsonRpcResponse,
): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(message));
  if (json.byteLength > MAX_RPC_JSON_BYTES) {
    throw new Error(`rpc json exceeds MAX_RPC_JSON_BYTES (${MAX_RPC_JSON_BYTES})`);
  }
  const body = new Uint8Array(1 + json.byteLength);
  body[0] = STDIO_RPC_TYPE;
  body.set(json, 1);
  return encodeStdioBody(body);
}

export function encodeLiveStdioFrame(
  header: ScreencastFrameHeader,
  image: Uint8Array,
): Uint8Array {
  return encodeStdioBody(encodeLiveFrame(header, image));
}

export type DecodedStdioFrame =
  | { type: typeof STDIO_RPC_TYPE; message: unknown }
  | {
      type: typeof STDIO_LIVE_TYPE;
      header: ScreencastFrameHeader;
      payload: Uint8Array;
    };

/** Decode one body (no leading u32). */
export function decodeStdioBody(body: Uint8Array): DecodedStdioFrame {
  if (body.byteLength < 1) throw new Error("stdio body empty");
  const type = body[0];
  if (type === STDIO_RPC_TYPE) {
    const jsonBytes = body.subarray(1);
    if (jsonBytes.byteLength > MAX_RPC_JSON_BYTES) {
      throw new Error("rpc json oversize");
    }
    const text = new TextDecoder().decode(jsonBytes);
    return { type: STDIO_RPC_TYPE, message: JSON.parse(text) as unknown };
  }
  if (type === STDIO_LIVE_TYPE) {
    const decoded = decodeLiveFrame(body);
    return {
      type: STDIO_LIVE_TYPE,
      header: decoded.header,
      payload: decoded.payload,
    };
  }
  throw new Error(`unknown stdio frame type ${type}`);
}

function readExact(
  read: (n: number) => Uint8Array | null,
  n: number,
): Uint8Array {
  const buf = read(n);
  if (!buf || buf.byteLength !== n) throw new Error("stdio truncated");
  return buf;
}

/** Pull one framed message: u32 BE length then body. */
export function readStdioFrame(
  read: (n: number) => Uint8Array | null,
): DecodedStdioFrame {
  const lenBuf = readExact(read, 4);
  const bodyLen = new DataView(
    lenBuf.buffer,
    lenBuf.byteOffset,
    lenBuf.byteLength,
  ).getUint32(0, false);
  if (bodyLen > MAX_STDIO_BODY_BYTES) {
    throw new Error(`stdio body_len ${bodyLen} > MAX_STDIO_BODY_BYTES`);
  }
  if (bodyLen < 1) throw new Error("stdio body_len < 1");
  return decodeStdioBody(readExact(read, bodyLen));
}

export function jsonRpcTransportError(
  id: string | number | null,
  code: JsonRpcTransportCode,
  message: string,
  data?: unknown,
): ComputerJsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: id ?? 0,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}
