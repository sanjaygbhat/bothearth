import type { LiveMode, ScreencastFrameHeader } from "../types/contracts.ts";

/**
 * Binary live-view frame body (also stdio type=1 payload):
 *   [u8 type=1][u32 BE headerLen][utf8 JSON ScreencastFrameHeader][JPEG/PNG bytes]
 * Endianness: headerLen big-endian.
 * Stream demux: wrap with stdio [u32 BE body_len] (see protocol/stdio.ts).
 */
export const LIVE_FRAME_TYPE = 1 as const;
export const LIVE_PROTOCOL_VERSION = 1 as const;
/** Max UTF-8 header JSON bytes. */
export const MAX_LIVE_HEADER_BYTES = 64 * 1024;
/** Max image payload bytes. */
export const MAX_LIVE_IMAGE_BYTES = 8 * 1024 * 1024;

export interface LiveHello {
  v: 1;
  t: "hello";
  session: string;
  epoch: number;
  viewport: { w: number; h: number; dpr: number };
  mode: LiveMode;
}

export interface LiveFrameAck {
  v: 1;
  t: "frame_ack";
  seq: number;
}

export interface LivePointer {
  v: 1;
  t: "pointer";
  epoch: number;
  kind: "move" | "down" | "up" | "wheel";
  x: number;
  y: number;
  button?: number;
  buttons?: number;
  mods?: number;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
}

export interface LiveKey {
  v: 1;
  t: "key";
  epoch: number;
  kind: "keyDown" | "keyUp" | "rawKeyDown" | "char" | "reset";
  code: string;
  key: string;
  text?: string;
  mods?: number;
}

export interface LiveText {
  v: 1;
  t: "text";
  epoch: number;
  text: string;
}

export interface LiveModeMsg {
  v: 1;
  t: "mode";
  mode: LiveMode;
  epoch: number;
  reason?: string;
  expires_at?: string | null;
}

export interface LiveHeartbeat {
  v: 1;
  t: "ping" | "pong";
}

export interface LiveInputAck {
  v: 1;
  t: "input_ack";
  epoch: number;
  expires_at?: string | null;
}

/** Server-to-client failure; clients must invalidate local screen authority. */
export interface LiveError {
  v: 1;
  t: "error";
  code: string;
  message: string;
}

/** Desktop capture child died or could not produce a first frame. */
export interface LiveProducer {
  v: 1;
  t: "producer";
  status: "restarting" | "failed";
  reason?: string;
}

export type LiveControlMessage =
  | LiveHello
  | LiveFrameAck
  | LivePointer
  | LiveKey
  | LiveText
  | LiveModeMsg
  | LiveHeartbeat
  | LiveInputAck
  | LiveError
  | LiveProducer;

export function encodeLiveFrame(
  header: ScreencastFrameHeader,
  payload: Uint8Array,
): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  if (headerBytes.length > MAX_LIVE_HEADER_BYTES) {
    throw new Error(`live header exceeds MAX_LIVE_HEADER_BYTES (${MAX_LIVE_HEADER_BYTES})`);
  }
  if (payload.length > MAX_LIVE_IMAGE_BYTES) {
    throw new Error(`live image exceeds MAX_LIVE_IMAGE_BYTES (${MAX_LIVE_IMAGE_BYTES})`);
  }
  const out = new Uint8Array(1 + 4 + headerBytes.length + payload.length);
  out[0] = LIVE_FRAME_TYPE;
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint32(1, headerBytes.length, false);
  out.set(headerBytes, 5);
  out.set(payload, 5 + headerBytes.length);
  return out;
}

export function decodeLiveFrame(buf: Uint8Array): {
  header: ScreencastFrameHeader;
  payload: Uint8Array;
} {
  if (buf.length < 5) throw new Error("live frame too short");
  if (buf[0] !== LIVE_FRAME_TYPE) throw new Error(`bad live frame type ${buf[0]}`);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerLen = view.getUint32(1, false);
  if (headerLen > MAX_LIVE_HEADER_BYTES) {
    throw new Error("live header oversize");
  }
  if (5 + headerLen > buf.length) throw new Error("live frame header truncated");
  const headerJson = new TextDecoder().decode(buf.subarray(5, 5 + headerLen));
  const header = JSON.parse(headerJson) as ScreencastFrameHeader;
  if (header.v !== LIVE_PROTOCOL_VERSION) {
    throw new Error(`unsupported live protocol v=${String(header.v)}`);
  }
  const payload = buf.subarray(5 + headerLen);
  if (payload.length > MAX_LIVE_IMAGE_BYTES) {
    throw new Error("live image oversize");
  }
  return { header, payload };
}

export function encodeControlMessage(msg: LiveControlMessage): string {
  return JSON.stringify(msg);
}

export function decodeControlMessage(raw: string): LiveControlMessage {
  const msg = JSON.parse(raw) as LiveControlMessage;
  if (msg.v !== 1 || typeof msg.t !== "string") {
    throw new Error("invalid live control message");
  }
  return msg;
}

export type LiveRelayMethod = "live.pointer" | "live.key" | "live.text";

/**
 * UI control frames carry `t`; the golden-run stand-in sends `type: "live.*"`
 * instead. Key and text frames must never fall through to live.pointer.
 */
export function liveRelayMethod(msg: unknown): LiveRelayMethod {
  if (!msg || typeof msg !== "object") return "live.pointer";
  const m = msg as { t?: unknown; type?: unknown };
  if (m.t === "key") return "live.key";
  if (m.t === "text") return "live.text";
  if (m.t === "pointer") return "live.pointer";
  if (m.type === "live.key" || m.type === "live.text" || m.type === "live.pointer") {
    return m.type;
  }
  return "live.pointer";
}
