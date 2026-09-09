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
  // Canvas uses object-fit: contain. Account for the visible image's margins,
  // especially when switching between a browser page and the taller desktop.
  const scale = canvasRect.width > 0 && canvasRect.height > 0
    ? Math.min(canvasRect.width / viewport.w, canvasRect.height / viewport.h) : 1;
  const left = canvasRect.left + (canvasRect.width - viewport.w * scale) / 2;
  const top = canvasRect.top + (canvasRect.height - viewport.h * scale) / 2;
  const x = (clientX - left) / scale;
  const y = (clientY - top) / scale;
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
