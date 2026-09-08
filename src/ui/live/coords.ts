import type { LiveMode } from "../../types/contracts.ts";
import type { LivePointer } from "../../protocol/live.ts";

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ViewportLike {
  w: number;
  h: number;
  dpr: number;
}

/** Client coordinates → CSS layout-viewport px. Never scaled by devicePixelRatio. */
export function mapClientToCssPx(
  clientX: number,
  clientY: number,
  canvasRect: RectLike,
  viewport: ViewportLike,
): { x: number; y: number } {
  const sx = canvasRect.width > 0 ? viewport.w / canvasRect.width : 1;
  const sy = canvasRect.height > 0 ? viewport.h / canvasRect.height : 1;
  const x = (clientX - canvasRect.left) * sx;
  const y = (clientY - canvasRect.top) * sy;
  return {
    x: clamp(x, 0, Math.max(0, viewport.w - 1e-6)),
    y: clamp(y, 0, Math.max(0, viewport.h - 1e-6)),
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/** Input is relayed only while the person holds control. */
export function shouldRelayInput(mode: LiveMode): boolean {
  return mode === "human";
}

/** `driver` is false in a window that is watching someone else drive. */
export function humanControlBanner(mode: LiveMode, driver = true): string | null {
  if (mode === "human") {
    return driver
      ? "You have control — your bot is not watching"
      : "Someone else has control — nothing you type is sent";
  }
  if (mode === "validating") return "Checking who is driving";
  return null;
}

export function buildPointerMessage(
  epoch: number,
  kind: LivePointer["kind"],
  x: number,
  y: number,
  extra?: Partial<LivePointer>,
): LivePointer {
  return {
    v: 1,
    t: "pointer",
    epoch,
    kind,
    x,
    y,
    ...extra,
  };
}
