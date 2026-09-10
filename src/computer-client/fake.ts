import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import type {
  LiveMode,
  ScreencastFrameHeader,
  TakeoverState,
  ToolName,
  ToolResult,
} from "../types/contracts.ts";
import {
  applyTakeoverTransition,
  isTakeoverBusy,
  isTakeoverExemptTool,
  toWireState,
} from "../protocol/takeover.ts";
import { toolError } from "../protocol/errors.ts";
import { encodeLiveFrame } from "../protocol/live.ts";
import type { ComputerClient } from "./types.ts";

const JPEG_MINI = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);

export interface FakeComputerOpts {
  ttlSec?: number;
}

/**
 * In-process fake computer-server. Speaks tool RPC + live frames and enforces
 * takeover busy fail-closed.
 */
export class FakeComputer extends EventEmitter implements ComputerClient {
  readonly computerId: string;
  private state: TakeoverState = "agent";
  private takeoverId: string | null = null;
  private expiresAt: string | null = null;
  private epoch = 1;
  private takeoverEpoch = 1;
  readonly relayed: unknown[] = [];
  private frameSeq = 0;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private readonly ttlSec: number;
  private closed = false;
  private readonly quarantined = new Set(["download_0123456789abcdef01234567"]);

  constructor(computerId: string, opts?: FakeComputerOpts) {
    super();
    this.computerId = computerId;
    this.ttlSec = opts?.ttlSec ?? 600;
  }

  getTakeoverState(): TakeoverState {
    return this.state;
  }

  async call(method: string, params?: unknown): Promise<ToolResult> {
    if (this.closed) {
      return toolError("E_SANDBOX_DEAD");
    }
    if (method === "takeover.request") return this.requestTakeover(params);
    const tool = method as ToolName;
    if (isTakeoverBusy(this.state) && !isTakeoverExemptTool(tool)) {
      return this.busyError();
    }

    if (tool === "request_takeover") {
      return this.requestTakeover(params);
    }
    if (tool === "takeover_status") {
      return this.takeoverStatus(params);
    }
    if (tool === "files_list") {
      return { ok: true, data: { entries: [] } };
    }
    if (method === "quarantine.list") {
      return {
        ok: true,
        data: {
          items: [...this.quarantined].map((id) => ({
            id,
            name: "sample.txt",
            size: 10,
            content_type: "text/plain",
            downloaded_at: "2026-09-04T00:00:00.000Z",
          })),
        },
      };
    }
    if (method === "quarantine.promote") {
      const id = String((params as { id?: unknown } | undefined)?.id ?? "");
      if (!this.quarantined.delete(id)) return toolError("E_IO", "quarantined download not found");
      return {
        ok: true,
        data: {
          id,
          name: "sample.txt",
          size: 10,
          content_type: "text/plain",
          downloaded_at: "2026-09-04T00:00:00.000Z",
          workspace_path: `/workspace/${id}-sample.txt`,
          quarantined: false,
        },
      };
    }
    if (tool === "done") {
      return { ok: true, data: { ok: true } };
    }
    if (tool === "browser_navigate" || tool === "browser_snapshot") {
      return {
        ok: true,
        data: {
          snapshot_id: `snap_${randomBytes(4).toString("hex")}`,
          yaml: "root:\n  - link \"Home\" [ref=e1]",
          truncated: false,
          refs: ["e1"],
          url: "https://example.com/",
          title: "Example",
        },
      };
    }
    if (tool === "browser_click") {
      return { ok: true, data: { clicked: true, method } };
    }
    if (tool === "browser_screenshot") {
      const jpeg = Buffer.from(JPEG_MINI).toString("base64");
      return {
        ok: true,
        data: {
          image_id: "img_fake",
          mime: "image/jpeg",
          width: 1,
          height: 1,
          css_width: 1,
          css_height: 1,
          scale: 1,
          scroll_x: 0,
          scroll_y: 0,
          jpeg_base64: jpeg,
        },
      };
    }
    return { ok: true, data: { ok: true, method } };
  }

  async grantTakeover(takeoverId: string): Promise<ToolResult> {
    if (this.takeoverId !== takeoverId) {
      return toolError("E_IO", "unknown takeover_id");
    }
    const next = applyTakeoverTransition(this.state, "grant");
    if (!next) return toolError("E_IO", "invalid takeover transition");
    // Capture barrier BEFORE UI ack: stop model-bound frames first.
    this.setMode("human");
    this.state = next;
    this.emit("takeover", { takeover_id: takeoverId, state: this.state });
    return {
      ok: true,
      data: {
        takeover_id: takeoverId,
        state: toWireState(this.state),
        expires_at: this.expiresAt,
        epoch: this.takeoverEpoch,
      },
    };
  }

  async releaseTakeover(takeoverId: string): Promise<ToolResult> {
    if (this.takeoverId !== takeoverId) {
      return toolError("E_IO", "unknown takeover_id");
    }
    const next = applyTakeoverTransition(this.state, "release");
    if (!next) return toolError("E_POLICY", "invalid takeover release");
    this.state = next;
    const validated = applyTakeoverTransition(this.state, "validated");
    if (validated) this.state = validated;
    this.setMode("agent");
    this.emit("takeover", { takeover_id: takeoverId, state: this.state });
    return {
      ok: true,
      data: {
        takeover_id: takeoverId,
        state: toWireState(this.state),
        expires_at: this.expiresAt,
      },
    };
  }

  async declineTakeover(takeoverId: string): Promise<ToolResult> {
    if (this.takeoverId !== takeoverId) {
      return toolError("E_IO", "unknown takeover_id");
    }
    const next = applyTakeoverTransition(this.state, "decline");
    if (!next) return toolError("E_POLICY", "invalid takeover decline");
    this.state = next;
    this.takeoverId = null;
    this.expiresAt = null;
    this.takeoverEpoch += 1;
    this.setMode("agent");
    this.emit("takeover", { takeover_id: takeoverId, state: this.state });
    return {
      ok: true,
      data: {
        takeover_id: takeoverId,
        state: toWireState(this.state),
        expires_at: this.expiresAt,
        epoch: this.takeoverEpoch,
      },
    };
  }

  async expireTakeover(takeoverId: string): Promise<ToolResult> {
    if (this.takeoverId !== takeoverId) return toolError("E_IO", "unknown takeover_id");
    const next = applyTakeoverTransition(this.state, "ttl");
    if (!next) return toolError("E_IO", "invalid takeover transition");
    this.state = next;
    this.setMode("human");
    return { ok: true, data: { takeover_id: takeoverId, state: toWireState(next) } };
  }

  startLive(intervalMs = 50): void {
    if (this.frameTimer) return;
    this.frameTimer = setInterval(() => {
      if (this.closed) return;
      this.emitFrame(this.state === "human" ? "human" : "agent");
    }, intervalMs);
    if (typeof this.frameTimer.unref === "function") this.frameTimer.unref();
  }

  stopLive(): void {
    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
  }

  async relayInput(msg: unknown): Promise<ToolResult> {
    if (this.state !== "human") {
      return toolError("E_TAKEOVER_BUSY", "input relay only during HUMAN");
    }
    this.relayed.push(msg);
    return { ok: true, data: { relayed: true } };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopLive();
    this.removeAllListeners();
  }

  private requestTakeover(params: unknown): ToolResult {
    const p = (params ?? {}) as { reason?: string };
    const next = applyTakeoverTransition(this.state, "request");
    if (!next) return toolError("E_IO", "invalid takeover transition");
    this.state = next;
    this.takeoverId = `tk_${randomBytes(8).toString("hex")}`;
    this.expiresAt = new Date(Date.now() + this.ttlSec * 1000).toISOString();
    this.takeoverEpoch += 1;
    this.emit("takeover", {
      takeover_id: this.takeoverId,
      state: this.state,
      reason: p.reason ?? "",
    });
    return {
      ok: true,
      data: {
        takeover_id: this.takeoverId,
        state: toWireState(this.state),
        expires_at: this.expiresAt,
        epoch: this.takeoverEpoch,
      },
    };
  }

  private takeoverStatus(params: unknown): ToolResult {
    const p = (params ?? {}) as { takeover_id?: string };
    const id = p.takeover_id ?? this.takeoverId;
    // The real RPC also reports agent control before the first lease exists.
    if (this.takeoverId && id !== this.takeoverId) {
      return toolError("E_IO", "unknown takeover_id");
    }
    return {
      ok: true,
      data: {
        takeover_id: id,
        state: toWireState(this.state),
        expires_at: this.expiresAt ?? new Date().toISOString(),
        epoch: this.takeoverEpoch,
      },
    };
  }

  private busyError(): ToolResult {
    return toolError("E_TAKEOVER_BUSY", undefined, {
      takeover_id: this.takeoverId,
      state: toWireState(this.state),
      expires_at: this.expiresAt,
    });
  }

  private setMode(mode: LiveMode): void {
    this.epoch += 1;
    this.emit("mode", { mode, epoch: this.epoch });
  }

  private emitFrame(mode: LiveMode): void {
    this.frameSeq += 1;
    const header: ScreencastFrameHeader = {
      v: 1,
      seq: this.frameSeq,
      ts: Date.now(),
      mime: "image/jpeg",
      mode,
      epoch: this.epoch,
      target: "page",
      viewport: { w: 1280, h: 720, dpr: 1 },
      meta: {
        offsetTop: 0,
        pageScaleFactor: 1,
        deviceWidth: 1280,
        deviceHeight: 720,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
      },
    };
    const frame = encodeLiveFrame(header, JPEG_MINI);
    this.emit("frame", { header, payload: JPEG_MINI, bytes: frame });
  }
}

export function createFakeComputerClient(
  computerId: string,
  opts?: FakeComputerOpts,
): FakeComputer {
  const c = new FakeComputer(computerId, opts);
  c.startLive();
  return c;
}
