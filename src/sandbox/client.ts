/**
 * Length-prefixed JSON-RPC client over duplex stdio (ARCH §5).
 */

import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import {
  decodeStdioBody,
  encodeRpcFrame,
  MAX_STDIO_BODY_BYTES,
  STDIO_RPC_TYPE,
} from "../protocol/stdio.ts";
import type {
  ComputerJsonRpcRequest,
  ComputerJsonRpcResponse,
  ScreencastFrameHeader,
} from "../types/contracts.ts";

export interface JsonRpcClient {
  request(method: string, params?: unknown, id?: string | number): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(graceMs?: number): Promise<void>;
  readonly child: ChildProcess | null;
  readonly closed?: boolean;
}

/**
 * How long the computer-server gets to shut Chromium down after stdin EOF.
 * Killing it sooner loses the logins and profile locks that close flushes.
 */
export const CLOSE_GRACE_MS = 5_000;

/** True once the child has exited, false once `ms` passed without it. */
function exited(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, ms);
    timer.unref?.();
    child.once("exit", onExit);
  });
}

class FrameReader {
  private buf = Buffer.alloc(0);
  private waiters: Array<{ n: number; resolve: (b: Buffer | null) => void }> = [];
  private ended = false;

  constructor(stream: Readable) {
    stream.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.drain();
    });
    const end = () => {
      this.ended = true;
      this.drain();
    };
    stream.on("end", end);
    stream.on("error", end);
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const w = this.waiters[0]!;
      if (this.buf.length >= w.n) {
        const slice = this.buf.subarray(0, w.n);
        this.buf = this.buf.subarray(w.n);
        this.waiters.shift();
        w.resolve(slice);
      } else if (this.ended) {
        this.waiters.shift();
        w.resolve(null);
      } else break;
    }
  }

  read(n: number): Promise<Buffer | null> {
    if (this.buf.length >= n) {
      const slice = this.buf.subarray(0, n);
      this.buf = this.buf.subarray(n);
      return Promise.resolve(slice);
    }
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push({ n, resolve }));
  }
}

export function createJsonRpcClient(
  stdin: Writable,
  stdout: Readable,
  child: ChildProcess | null = null,
  onLiveFrame?: (header: ScreencastFrameHeader, payload: Uint8Array) => void,
): JsonRpcClient {
  const reader = new FrameReader(stdout);
  let nextId = 1;
  const pending = new Map<
    string | number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      promise: Promise<unknown>;
    }
  >();
  let closed = false;
  let loop: Promise<void> | null = null;

  let terminalError: Error | null = null;
  const fail = (err: Error) => {
    if (terminalError) return;
    terminalError = err;
    closed = true;
    for (const [, p] of pending) {
      p.reject(err);
      void p.promise.catch(() => undefined);
    }
    pending.clear();
  };

  stdin.on("error", fail);

  if (child) {
    child.on("error", fail);
    child.on("exit", (code, signal) => {
      fail(
        new Error(
          `computer-server exited (code=${code ?? "null"} signal=${signal ?? "null"})`,
        ),
      );
    });
  }

  const ensureLoop = () => {
    if (loop) return;
    loop = (async () => {
      while (!closed) {
        const lenBuf = await reader.read(4);
        if (!lenBuf) {
          fail(new Error("computer-server stream closed"));
          break;
        }
        const bodyLen = lenBuf.readUInt32BE(0);
        if (bodyLen > MAX_STDIO_BODY_BYTES || bodyLen < 1) {
          fail(new Error("stdio framing error"));
          break;
        }
        const bodyBuf = await reader.read(bodyLen);
        if (!bodyBuf) {
          fail(new Error("computer-server stream closed"));
          break;
        }
        let decoded;
        try {
          decoded = decodeStdioBody(new Uint8Array(bodyBuf));
        } catch (e) {
          fail(e instanceof Error ? e : new Error(String(e)));
          break;
        }
        if (decoded.type !== STDIO_RPC_TYPE) {
          onLiveFrame?.(decoded.header, decoded.payload);
          continue;
        }
        const msg = decoded.message as ComputerJsonRpcResponse;
        if (msg && typeof msg === "object" && "id" in msg) {
          const p = pending.get(msg.id);
          if (!p) continue;
          pending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(`json-rpc ${msg.error.code}: ${msg.error.message}`));
          } else {
            p.resolve(msg.result);
          }
        }
      }
    })().catch((error: unknown) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
  };

  let writeTail = Promise.resolve();
  const writeFrame = (msg: ComputerJsonRpcRequest): Promise<void> => {
    const run = writeTail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          // close() can run after a request was queued but before this write.
          if (closed || stdin.destroyed || stdin.writableEnded) {
            reject(terminalError ?? new Error("client closed"));
            return;
          }
          stdin.write(Buffer.from(encodeRpcFrame(msg)), (err) =>
            err ? reject(err) : resolve(),
          );
        }),
    );
    writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    child,
    get closed() { return closed; },
    async request(method, params, id) {
      if (closed) throw terminalError ?? new Error("client closed");
      ensureLoop();
      const reqId = id ?? nextId++;
      const req: ComputerJsonRpcRequest = {
        jsonrpc: "2.0",
        id: reqId,
        method,
        ...(params !== undefined ? { params } : {}),
      };
      let entry!: {
        resolve: (v: unknown) => void;
        reject: (e: Error) => void;
        promise: Promise<unknown>;
      };
      const result = new Promise<unknown>((resolve, reject) => {
        entry = { resolve, reject, promise: undefined as unknown as Promise<unknown> };
      });
      entry.promise = result;
      // A stream failure can reject the response while the write is still pending.
      void result.catch(() => undefined);
      pending.set(reqId, entry);
      try {
        await writeFrame(req);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      return await result;
    },
    async notify(method, params) {
      if (closed) throw terminalError ?? new Error("client closed");
      ensureLoop();
      await writeFrame({
        jsonrpc: "2.0",
        id: -1,
        method,
        ...(params !== undefined ? { params } : {}),
      });
    },
    async close(graceMs = CLOSE_GRACE_MS) {
      fail(new Error("client closed"));
      try {
        stdin.end();
      } catch {
        /* ignore */
      }
      // EOF on stdin is the computer-server's shutdown signal: it closes the
      // browser, which writes cookies and releases the profile lock. Only kill
      // the exec once it has had that time.
      if (child && child.exitCode === null && !(await exited(child, graceMs))) {
        child.kill("SIGTERM");
        if (!(await exited(child, 1_000))) child.kill("SIGKILL");
      }
      if (loop) await loop.catch(() => undefined);
    },
  };
}
