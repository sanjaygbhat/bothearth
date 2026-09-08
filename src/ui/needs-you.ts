/**
 * The in-app "your bot needs you" fallback.
 *
 * A macOS notification is the nice path, and in an ad-hoc-signed build macOS
 * refuses `UNUserNotificationCenter` outright, so the window itself has to
 * carry it on every route:
 *
 *   - a strip under the titlebar with the countdown and one button
 *   - the window title becomes "● Needs you — ModelBot", in the tab AND in the
 *     native window, so the Dock, ⌘Tab and the window list all say it
 *   - the Dock badge and one Dock bounce (native.ts `sync`)
 *   - the menu-bar item flipping to "Waiting for you", with a different mark
 *     (native.ts `setAttention`, then the Swift shell)
 *
 * Nothing here polls: `attention` already watches `WS /api/v1/events` and
 * reconciles against the API. This subscribes to it, and runs a one-second tick
 * only while there is a deadline to count down.
 */

import { attention, modelbotNative, type AttentionItem } from "./native.ts";
import { onDocumentTitle, setAttention } from "./shell.ts";

/** `48` -> `0:48`, `125` -> `2:05`. Seconds, floored at zero. */
export function countdownText(msLeft: number): string {
  const total = Math.max(0, Math.floor(msLeft / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The soonest deadline among the things waiting, or null when none has one. */
export function soonestDeadline(items: AttentionItem[]): number | null {
  const times = items
    .map((item) => (item.expiresAt ? Date.parse(item.expiresAt) : Number.NaN))
    .filter((value) => Number.isFinite(value));
  return times.length ? Math.min(...times) : null;
}

/**
 * What the strip says. Pure, so the wording is testable without a DOM.
 * `null` when nothing is waiting.
 */
export function attentionBanner(
  items: AttentionItem[],
  now: number = Date.now(),
): { count: number; text: string; sub?: string; route: string } | null {
  if (!items.length) return null;
  const first = items[0] as AttentionItem;
  const deadline = soonestDeadline(items);
  const text =
    items.length === 1
      ? "Your bot needs you"
      : `Your bot needs you — ${items.length} things are waiting`;
  const sub =
    deadline === null
      ? undefined
      : deadline <= now
        ? "Time is up — it stopped and is waiting for you"
        : `${countdownText(deadline - now)} left`;
  return {
    count: items.length,
    text,
    ...(sub ? { sub } : {}),
    route: first.taskId ? `#/tasks/${first.taskId}` : "#/",
  };
}

let tick: ReturnType<typeof setInterval> | undefined;
let latest: AttentionItem[] = [];

function paint(): void {
  const banner = attentionBanner(latest);
  setAttention(banner);

  const needsTick = banner !== null && soonestDeadline(latest) !== null;
  if (needsTick && tick === undefined) {
    tick = setInterval(paint, 1000);
  } else if (!needsTick && tick !== undefined) {
    clearInterval(tick);
    tick = undefined;
  }
}

let titleBridge: (() => void) | null = null;

let started = false;

/** Idempotent. Safe before `attention.start()`; it just paints nothing. */
function watchAttention(): () => void {
  if (started) return () => {};
  started = true;
  // The shell owns the title text; this only carries it across the bridge, and
  // only in the Mac app — in a browser `document.title` is already the tab.
  titleBridge = onDocumentTitle((title) => {
    if (modelbotNative.isNative) modelbotNative.setTitle(title);
  });
  const stop = attention.subscribe((items) => {
    latest = items;
    paint();
  });
  latest = attention.pending();
  paint();
  return () => {
    stop();
    titleBridge?.();
    titleBridge = null;
    if (tick !== undefined) clearInterval(tick);
    tick = undefined;
    started = false;
  };
}

if (typeof document !== "undefined" && document.getElementById("shell")) {
  watchAttention();
}
