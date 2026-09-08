import { readStdioFrame, STDIO_RPC_TYPE, encodeRpcFrame } from "../../src/protocol/stdio.ts";

/** Frame reader over a fixed buffer: returns null once the buffer runs short. */
export function readerFrom(buf: Uint8Array): (n: number) => Uint8Array | null {
  let offset = 0;
  return (n: number) => {
    if (offset + n > buf.byteLength) return null;
    const slice = buf.subarray(offset, offset + n);
    offset += n;
    return slice;
  };
}

/** Frame reader that consumes from a buffer still being filled by a live stream. */
export function readerFromBuffer(state: { buf: Uint8Array }): (n: number) => Uint8Array | null {
  return (n: number) => {
    if (state.buf.byteLength < n) return null;
    const out = state.buf.subarray(0, n);
    state.buf = state.buf.subarray(n);
    return out;
  };
}

/** Write one RPC frame and wait for the next RPC frame to arrive in `state`. */
export async function rpc(
  write: (b: Uint8Array) => void,
  state: { buf: Uint8Array },
  method: string,
  params: unknown,
  id: number,
  timeoutMs = 60_000,
): Promise<{ result?: { ok: boolean; data?: Record<string, unknown>; error?: unknown } }> {
  write(encodeRpcFrame({ jsonrpc: "2.0", id, method, params }));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const frame = readStdioFrame(readerFromBuffer(state));
      if (frame.type === STDIO_RPC_TYPE) return frame.message as never;
    } catch {
      /* need more bytes */
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`rpc timeout: ${method}`);
}
