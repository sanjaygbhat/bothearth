import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { wsAcceptKey } from "./auth.ts";

export interface WsSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onMessage(cb: (data: Buffer, isBinary: boolean) => void): void;
  onClose(cb: () => void): void;
  readonly readyState: "open" | "closed";
}

const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
export const MAX_WEBSOCKET_FRAME_BYTES = 1024 * 1024;

/**
 * Minimal RFC6455 server (ws-less). Node ships WebSocket client only;
 * handshake + framing here — no `ws` dependency.
 */
export function acceptWebSocket(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
): WsSocket | null {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || req.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return null;
  }

  const accept = wsAcceptKey(key);
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"),
  );
  if (head.length) socket.unshift(head);

  let readyState: "open" | "closed" = "open";
  let buf = Buffer.alloc(0);
  const messageListeners: Array<(data: Buffer, isBinary: boolean) => void> = [];
  const closeListeners: Array<() => void> = [];
  let closedEmitted = false;

  function emitClose(): void {
    if (closedEmitted) return;
    closedEmitted = true;
    readyState = "closed";
    for (const cb of closeListeners) cb();
  }

  function sendFrame(opcode: number, payload: Buffer): void {
    if (readyState !== "open") return;
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  }

  const api: WsSocket = {
    get readyState() {
      return readyState;
    },
    send(data: string | Uint8Array) {
      if (typeof data === "string") {
        sendFrame(OP_TEXT, Buffer.from(data, "utf8"));
      } else {
        sendFrame(OP_BIN, Buffer.from(data));
      }
    },
    close(code = 1000, reason = "") {
      if (readyState !== "open") return;
      const reasonBuf = Buffer.from(reason, "utf8");
      const payload = Buffer.alloc(2 + reasonBuf.length);
      payload.writeUInt16BE(code, 0);
      reasonBuf.copy(payload, 2);
      sendFrame(OP_CLOSE, payload);
      readyState = "closed";
      socket.end();
      emitClose();
    },
    onMessage(cb) {
      messageListeners.push(cb);
    },
    onClose(cb) {
      closeListeners.push(cb);
    },
  };

  socket.on("data", (chunk: Buffer) => {
    if (buf.length + chunk.length > MAX_WEBSOCKET_FRAME_BYTES + 14) {
      api.close(1009, "too large");
      return;
    }
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      if (buf.length < 2) return;
      const b0 = buf[0]!;
      const b1 = buf[1]!;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
          api.close(1009, "too large");
          return;
        }
        len = Number(big);
        offset = 10;
      }
      if (len > MAX_WEBSOCKET_FRAME_BYTES) {
        api.close(1009, "too large");
        return;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + len) return;
      let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = buf.subarray(offset, offset + 4);
        const out = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) {
          out[i] = payload[i]! ^ mask[i % 4]!;
        }
        payload = out;
      }
      buf = buf.subarray(offset + maskLen + len);

      if (opcode === OP_CLOSE) {
        api.close(1000);
        return;
      }
      if (opcode === OP_PING) {
        sendFrame(OP_PONG, payload);
        continue;
      }
      if (opcode === OP_PONG) continue;
      if (opcode === OP_TEXT || opcode === OP_BIN) {
        for (const cb of messageListeners) cb(payload, opcode === OP_BIN);
      }
    }
  });

  socket.on("close", () => emitClose());
  socket.on("error", () => {
    socket.destroy();
    emitClose();
  });

  return api;
}

export function rejectUpgrade(socket: Socket, status: number, message: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

export function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}
