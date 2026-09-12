import type {
  ComputerJsonRpcRequest,
  ComputerJsonRpcResponse,
  ScreencastFrameHeader,
} from "../../src/types/contracts.ts";
import {
  JSON_RPC_ERROR,
  MAX_STDIO_BODY_BYTES,
  STDIO_RPC_TYPE,
  encodeLiveStdioFrame,
  encodeRpcFrame,
  jsonRpcTransportError,
} from "../../src/protocol/stdio.ts";
import { createState, dispatch, type Role, type ServerState } from "./dispatch.ts";

function makeStdinBuffer(): {
  push(chunk: Buffer): void;
  take(n: number): Uint8Array | null;
  end(): void;
  ended: boolean;
} {
  let buf = Buffer.alloc(0);
  let ended = false;
  return {
    get ended() {
      return ended;
    },
    push(chunk: Buffer) {
      buf = Buffer.concat([buf, chunk]);
    },
    take(n: number) {
      if (buf.byteLength < n) return null;
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      return new Uint8Array(out);
    },
    end() {
      ended = true;
    },
  };
}

async function readExact(
  buf: ReturnType<typeof makeStdinBuffer>,
  n: number,
): Promise<Uint8Array | null> {
  for (;;) {
    const got = buf.take(n);
    if (got) return got;
    if (buf.ended) return null;
    await new Promise((r) => setTimeout(r, 5));
  }
}

function writeFrame(frame: Uint8Array): void {
  process.stdout.write(Buffer.from(frame));
}

export type { Role };

/**
 * Long enough for Chromium to unlink its profile lock and flush cookies, short
 * enough that the container stop that sent the signal does not have to escalate
 * to SIGKILL. A browser killed mid-flight leaves `SingletonLock` behind and the
 * persistent profile — a volume that outlives the container — is then unusable.
 */
const SHUTDOWN_MS = 5_000;

export async function closeBrowser(
  state: ServerState,
  ms = SHUTDOWN_MS,
): Promise<void> {
  const browser = state.browser;
  if (!browser) return;
  browser.abortActs();
  await Promise.race([
    browser.close().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, ms).unref()),
  ]);
}

export function installShutdown(state: ServerState, exit: (code: number) => void): void {
  const stop = () => void closeBrowser(state).then(() => exit(0));
  // `once`: a second signal takes the default action, so an operator in a hurry
  // is never held by the close. Playwright's handlers for these are off, so
  // this is the only thing that closes the browser (see browser/session.ts).
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.once(signal, stop);
  }
}

export async function runStdioServer(role: Role): Promise<void> {
  const state: ServerState = createState(role);
  installShutdown(state, (code) => process.exit(code));
  state.onLiveFrame = (h: ScreencastFrameHeader, jpeg: Uint8Array) => {
    if (process.stdout.writableLength > 0) return;
    try {
      writeFrame(encodeLiveStdioFrame(h, jpeg));
    } catch {
      /* drop */
    }
  };
  state.onLiveControl = (msg) => {
    try {
      writeFrame(encodeRpcFrame({ jsonrpc: "2.0", method: "live.producer", params: msg }));
    } catch {
      /* drop */
    }
  };

  const buf = makeStdinBuffer();
  process.stdin.on("data", (c: Buffer) => buf.push(c));
  process.stdin.on("end", () => buf.end());
  process.stdin.resume();

  for (;;) {
    const lenBuf = await readExact(buf, 4);
    if (!lenBuf) break;
    const bodyLen = new DataView(
      lenBuf.buffer,
      lenBuf.byteOffset,
      lenBuf.byteLength,
    ).getUint32(0, false);
    if (bodyLen < 1 || bodyLen > MAX_STDIO_BODY_BYTES) {
      process.stderr.write("stdio body_len out of range\n");
      break;
    }
    const body = await readExact(buf, bodyLen);
    if (!body) break;
    if (body[0] !== STDIO_RPC_TYPE) {
      if (role === "shell") {
        process.stderr.write("live frame forbidden on shell role\n");
        break;
      }
      continue;
    }

    let msg: unknown;
    try {
      msg = JSON.parse(new TextDecoder().decode(body.subarray(1)));
    } catch {
      writeFrame(
        encodeRpcFrame(
          jsonRpcTransportError(null, JSON_RPC_ERROR.PARSE, "parse error"),
        ),
      );
      continue;
    }

    const req = msg as ComputerJsonRpcRequest;
    if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      writeFrame(
        encodeRpcFrame(
          jsonRpcTransportError(
            (req as { id?: string | number | null })?.id ?? null,
            JSON_RPC_ERROR.INVALID_REQUEST,
            "invalid request",
          ),
        ),
      );
      continue;
    }

    try {
      const result = await dispatch(state, req);
      writeFrame(
        encodeRpcFrame({
          jsonrpc: "2.0",
          id: req.id,
          result,
        } satisfies ComputerJsonRpcResponse),
      );
    } catch (e) {
      const err = e as Error;
      writeFrame(
        encodeRpcFrame({
          jsonrpc: "2.0",
          id: req.id,
          error: {
            code: JSON_RPC_ERROR.INTERNAL,
            message: err.message || "internal error",
          },
        }),
      );
    }
  }

  await closeBrowser(state);
}
