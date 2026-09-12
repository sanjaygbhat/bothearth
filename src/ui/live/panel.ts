/**
 * "Its computer" — the live view panel on the task view.
 *
 * Wraps `LiveView` without loosening any of its rules: input is relayed only
 * when the server says the mode is `human`, and the canvas is not a tab stop
 * while the bot is driving.
 */

import { appendTextChild } from "../safe.ts";
import { leaseText, SWITCH_GOOGLE_ACCOUNT } from "../takeover.ts";
import { icon } from "./icons.ts";
import { LiveView } from "./session.ts";

/** How long the control confirmation stays up when nobody types. */
const NOTICE_MS = 6000;

/** Overlay stays on "Starting…" this long with no frame, then tells the truth. */
export const NO_FRAME_HINT_MS = 8_000;
/** After this long with no frame, offer Restart the picture. */
export const NO_FRAME_RESTART_MS = 30_000;

/** S6 producer-restart notice — reused when the person asks to restart the picture. */
const RESTARTING_PICTURE = "Restarting the picture…";

/** The one line that tells a person the screen takes their keyboard now. */
export const DRIVING_HINT = "Click the computer to type. Ctrl+Alt+T opens Terminal; Ctrl+Alt+E opens Files. Use Return control when finished.";

/** What the live surface is called to a screen reader, per phase. */
export function screenLabel(phase: PanelPhase, url: string | null): string {
  if (phase === "driving") return "Its screen — you’re driving";
  if (phase === "observing") return "Its screen — someone else is driving";
  return url ? `What your bot sees: ${url}` : "What your bot sees";
}

export type PanelPhase =
  | "connecting"
  | "live"
  | "paused"
  | "driving"
  | "observing"
  | "ended"
  | "offline";

export interface LivePanelOptions {
  computerId: string | null;
  /** Section eyebrow. "Its computer" everywhere; "Last screen" when finished. */
  label?: string;
  onTakeControl?: () => void;
  onReturnControl?: () => void;
  onSwitchGoogleAccount?: () => void;
  onFullScreen?: (full: boolean) => void;
  /** An input reached the computer, which restarts the human's lease. */
  onInput?: () => void;
}

type PhaseCopy = {
  state: string;
  dot: string;
  note: string;
  dim: boolean;
};

/** One row of user-facing copy per phase — no phase is left to a fallback. */
export function phaseCopy(phase: PanelPhase): PhaseCopy {
  switch (phase) {
    case "live":
      return {
        state: "Live",
        dot: "dot ok",
        note: "Watch if you like. Take control any time you want to use its computer yourself.",
        dim: false,
      };
    case "paused":
      return {
        state: "Paused",
        dot: "dot warn",
        note: "The login is on this screen, in its browser. Nothing happens on its computer until you answer.",
        dim: true,
      };
    case "driving":
      return {
        state: "You are driving",
        dot: "dot run",
        note: "Frozen for your bot while you drive. It sees nothing here.",
        dim: false,
      };
    case "observing":
      return {
        state: "Someone else is driving",
        dot: "dot warn",
        note: "Someone else has control of its computer. Nothing you type here is sent.",
        dim: false,
      };
    case "ended":
      return {
        state: "Finished",
        dot: "dot",
        // "in this session": the picture is the one this page received, not
        // something the daemon kept. A later visit has no frame to show.
        note: "The last thing your bot saw in this session. Its computer has been put away.",
        dim: true,
      };
    case "offline":
      return {
        state: "Not connected",
        dot: "dot",
        note: "Connection interrupted. Reconnecting automatically…",
        dim: true,
      };
    default:
      return {
        state: "Connecting",
        dot: "dot",
        note: "Getting a picture of its computer.",
        dim: false,
      };
  }
}

/**
 * What stands in for the picture while there is nothing worth looking at.
 *
 * A browser that has opened nothing still paints frames — of a blank tab — so
 * "a frame arrived" is not the same as "there is something to see". Until the
 * computer is on a page, this says what it is doing instead of showing an empty
 * grey rectangle.
 */
export function waitingCopy(phase: PanelPhase, url: string | null = null, waitedMs = 0): string {
  if (phase === "offline") {
    return "Reconnecting automatically. Nothing you type is sent until the picture returns.";
  }
  if (phase === "paused") {
    return "Waiting for your answer. Its computer opens a page once you reply.";
  }
  if (phase === "connecting") {
    return waitedMs >= NO_FRAME_HINT_MS
      ? "No picture yet from its computer. It may be busy loading a page."
      : "Starting its computer…";
  }
  return url ?? "No picture yet. Take control still works.";
}

/** `https://google.com/flights?x=1` -> `google.com/flights`. Never a scheme. */
export function shortUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
    return `${url.host}${path}`;
  } catch {
    return null;
  }
}

export class LivePanel {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private readonly view: HTMLElement;
  private readonly screen: HTMLElement;
  private readonly waiting: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly driveBar: HTMLElement;
  private readonly driveLease: HTMLElement;
  private readonly urlText: HTMLElement;
  private readonly urlDot: HTMLElement;
  private readonly stateText: HTMLElement;
  private readonly noteText: HTMLElement;
  private readonly hintText: HTMLElement;
  private readonly acts: HTMLElement;
  private readonly takeBtn: HTMLButtonElement;
  private readonly returnBtn: HTMLButtonElement;
  private readonly googleBtn: HTMLButtonElement;
  private readonly fullBtn: HTMLButtonElement;
  private readonly reconnectBtn: HTMLButtonElement;
  private live: LiveView | null = null;
  private phase: PanelPhase = "connecting";
  private url: string | null = null;
  private hasFrame = false;
  private driver = false;
  private full = false;
  private fullScreenDeny: string | null = null;
  private noticeTimer = 0;
  private waitTimer = 0;
  /** 0 = Starting…; 1 = no-picture hint; 2 = Restart the picture offered. */
  private waitStage = 0;
  private heldReconnect = false;
  private readonly opts: LivePanelOptions;
  private readonly onFullScreenChange = () => {
    // Esc out of the browser's full screen tells this page nothing else: the
    // layout goes back, the keyboard stays exactly where it was.
    if (this.full && document.fullscreenElement !== this.root) {
      this.applyFullScreen(false);
      this.focusScreen();
    }
  };

  constructor(opts: LivePanelOptions) {
    this.opts = opts;
    this.root = document.createElement("div");
    this.root.className = "task-side";

    const head = appendTextChild(this.root, "div", "", "side-head");
    appendTextChild(head, "span", opts.label ?? "Its computer", "caps");
    this.stateText = appendTextChild(head, "span", "Connecting", "state");
    this.stateText.setAttribute("role", "status");

    // Full screen hides every other control. This is what is left: how long
    // the keyboard is yours, and how to hand it back.
    this.driveBar = appendTextChild(this.root, "div", "", "drive-bar");
    this.driveBar.hidden = true;
    this.driveLease = appendTextChild(this.driveBar, "span", "", "lease");
    const giveBtn = document.createElement("button");
    giveBtn.type = "button";
    giveBtn.className = "btn primary sm";
    giveBtn.textContent = "Give control back";
    giveBtn.addEventListener("click", () => opts.onReturnControl?.());
    this.googleBtn = document.createElement("button");
    this.googleBtn.type = "button";
    this.googleBtn.className = "btn ghost sm";
    this.googleBtn.textContent = SWITCH_GOOGLE_ACCOUNT;
    this.googleBtn.addEventListener("click", () => opts.onSwitchGoogleAccount?.());
    this.driveBar.append(giveBtn, this.googleBtn);

    this.view = appendTextChild(this.root, "div", "", "view");
    appendTextChild(this.view, "span", "", "wipe");

    const bar = appendTextChild(this.view, "div", "", "bar");
    this.urlDot = appendTextChild(bar, "span", "", "dot");
    this.urlText = appendTextChild(bar, "span", "Its computer", "url");

    this.screen = appendTextChild(this.view, "div", "", "screen");
    this.canvas = document.createElement("canvas");
    this.canvas.width = 1280;
    this.canvas.height = 800;
    this.canvas.tabIndex = -1;
    // A bare <canvas> with an aria-label is an AXImage and cannot take key
    // focus, so while you drive this is an interactive surface and says so;
    // while the bot drives it is a picture and says that instead.
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", screenLabel("connecting", null));
    this.screen.append(this.canvas);
    this.waiting = appendTextChild(this.screen, "div", waitingCopy("connecting"), "waiting");

    // Control landed, or it did not. Either way it is said here, over the
    // picture it is about, and it never blocks the frame underneath.
    this.notice = appendTextChild(this.screen, "div", "", "notice");
    this.notice.hidden = true;
    this.notice.setAttribute("role", "status");
    this.notice.setAttribute("aria-live", "polite");

    // The authoritative control banner from live/session.ts. It duplicates the
    // visible label, so it is announced rather than drawn twice.
    const banner = appendTextChild(this.root, "span", "", "sr-only");
    banner.setAttribute("role", "status");

    this.noteText = appendTextChild(this.root, "p", "", "view-note");
    this.hintText = appendTextChild(this.root, "p", DRIVING_HINT, "view-hint");
    this.hintText.hidden = true;

    this.acts = appendTextChild(this.root, "div", "", "view-acts");
    this.takeBtn = document.createElement("button");
    this.takeBtn.type = "button";
    this.takeBtn.className = "btn";
    this.takeBtn.append(icon("hand"), document.createTextNode("Take control"));
    this.takeBtn.addEventListener("click", () => opts.onTakeControl?.());

    this.returnBtn = document.createElement("button");
    this.returnBtn.type = "button";
    this.returnBtn.className = "btn primary";
    this.returnBtn.textContent = "Give control back";
    this.returnBtn.hidden = true;
    this.returnBtn.addEventListener("click", () => opts.onReturnControl?.());

    this.fullBtn = document.createElement("button");
    this.fullBtn.type = "button";
    this.fullBtn.className = "btn";
    this.fullBtn.textContent = "Full screen";
    this.fullBtn.addEventListener("click", () => void this.setFullScreen(!this.full));

    this.reconnectBtn = document.createElement("button");
    this.reconnectBtn.type = "button";
    this.reconnectBtn.className = "btn";
    this.reconnectBtn.textContent = "Reconnect";
    this.reconnectBtn.hidden = true;
    this.reconnectBtn.addEventListener("click", () => {
      const restart = this.reconnectBtn.textContent === "Restart the picture";
      this.reconnectBtn.hidden = true;
      this.reconnectBtn.textContent = "Reconnect";
      this.clearNoFrameWatch();
      this.setPhase("connecting");
      if (restart) this.setNotice(RESTARTING_PICTURE);
      if (this.live) this.live.reconnect();
      else this.connect();
      this.startNoFrameWatch();
      this.updateWaiting();
    });

    this.acts.append(this.takeBtn, this.returnBtn, this.fullBtn, this.reconnectBtn);

    if (opts.computerId) {
      this.live = new LiveView(this.canvas, banner, opts.computerId, {
        onConnecting: () => {
          if (this.reconnectBtn.textContent === "Reconnect") this.reconnectBtn.hidden = true;
          if (!this.driver) this.setPhase("connecting");
          this.updateWaiting();
        },
        onFrame: () => {
          this.hasFrame = true;
          this.reconnectBtn.hidden = true;
          if (this.heldReconnect) {
            this.heldReconnect = false;
            this.clearNotice();
          }
          if (this.driver) this.setPhase("driving");
          else if (this.phase === "connecting" || this.phase === "offline") this.setPhase("live");
          this.updateWaiting();
        },
        onMode: (mode) => {
          // The server’s control state is the authority on whether a person is
          // driving; who that person is, is `driver`. The optimistic UI in
          // task.ts is corrected here, in both directions.
          if (mode === "human") this.setPhase(this.driver ? "driving" : "observing");
          else if (mode === "validating") { this.hasFrame = false; this.setPhase("paused"); }
          else if (this.phase === "driving" || this.phase === "observing") this.setPhase("live");
          else if (this.phase === "connecting" && this.hasFrame) this.setPhase("live");
        },
        onError: (err, recovery) => {
          this.hasFrame = this.hasPainted();
          if (recovery?.held) {
            this.heldReconnect = true;
            this.reconnectBtn.hidden = true;
            this.setNotice(err.message, recovery.tone ?? "ok");
            if (this.driver) this.setPhase("driving");
            this.updateWaiting();
            return;
          }
          this.heldReconnect = false;
          this.reconnectBtn.textContent = "Reconnect";
          this.reconnectBtn.hidden = false;
          this.setPhase("offline");
          this.updateWaiting();
        },
        onInput: () => {
          // First keystroke: the confirmation has been read or does not matter.
          if (!this.heldReconnect) this.clearNotice();
          opts.onInput?.();
        },
      });
    } else {
      this.waiting.textContent = "This task has no computer to show.";
    }

    document.addEventListener("fullscreenchange", this.onFullScreenChange);
    this.applyPhase();
  }

  connect(): void {
    this.live?.connect();
  }

  /** `keepFrame` keeps the last picture on screen for the receipt to label. */
  close(keepFrame = false): void {
    this.clearNoFrameWatch();
    this.live?.close(keepFrame);
    this.live = null;
    if (!keepFrame) this.hasFrame = false;
    this.clearNotice();
    // A task that finishes while you are full screen must not leave you there
    // with the browser's Esc as the only way back to the app.
    if (this.full) void this.setFullScreen(false);
    document.removeEventListener("fullscreenchange", this.onFullScreenChange);
  }

  /**
   * Say one thing over the picture: control landed, or why it did not.
   *
   * It goes on its own after `NOTICE_MS`, or the moment an input actually
   * reaches the computer — by then the answer is on screen.
   */
  setNotice(text: string, tone: "ok" | "warn" = "ok"): void {
    this.notice.textContent = text;
    this.notice.className = tone === "warn" ? "notice warn" : "notice";
    this.notice.hidden = false;
    window.clearTimeout(this.noticeTimer);
    if (!this.heldReconnect) this.noticeTimer = window.setTimeout(() => this.clearNotice(), NOTICE_MS);
  }

  clearNotice(): void {
    window.clearTimeout(this.noticeTimer);
    this.noticeTimer = 0;
    this.notice.textContent = "";
    this.notice.hidden = true;
  }

  /** The lease countdown, so the full-screen bar says it too. */
  setLease(msLeft: number | null): void {
    this.driveLease.textContent = msLeft === null ? "" : leaseText(msLeft);
  }

  /** Latest `expires_at` from the live session (`mode` or `input_ack`). */
  leaseExpiresAt(): number | null {
    return this.live?.leaseExpiresAt() ?? null;
  }

  /** When that deadline was last taken from the server. */
  leaseSeenAt(): number | null {
    return this.live?.leaseSeenAt() ?? null;
  }

  /**
   * Does the person at this page hold the keyboard? Every window watching this
   * computer sees the same `human` mode; only the holder's may send.
   */
  setDriver(driver: boolean): void {
    if (this.driver === driver) return;
    this.driver = driver;
    this.live?.setDriver(driver);
    if (this.phase === "driving" || this.phase === "observing") {
      this.setPhase(driver ? "driving" : "observing");
    }
  }

  getPhase(): PanelPhase {
    return this.phase;
  }

  /**
   * True when this page is holding a picture worth showing: a frame arrived and
   * its pixels are still on the canvas.
   *
   * The flag alone is not enough. `LiveView` wipes the canvas whenever it
   * reconnects — a tab coming back from the background, a `pageshow` — and a
   * reconnect that never paints again leaves the flag saying "kept" over an
   * empty rectangle. A finished task then drew a bare, blank canvas under
   * "Last screen" instead of the honest line saying no picture was kept. A
   * cleared canvas is transparent everywhere and a painted frame is opaque, so
   * one pixel settles it; a canvas that cannot be read is not evidence of loss.
   */
  hasPainted(): boolean {
    if (!this.hasFrame) return false;
    const ctx = this.canvas.getContext?.("2d");
    if (!ctx || typeof ctx.getImageData !== "function") return true;
    try {
      return ctx.getImageData(0, 0, 1, 1).data[3] !== 0;
    } catch {
      return true;
    }
  }

  setPhase(phase: PanelPhase): void {
    if (this.phase === phase) return;
    const wasDriving = this.phase === "driving";
    this.phase = phase;
    if (wasDriving && phase !== "driving") {
      this.clearNotice();
      // Reverse the handoff: the ember bar retracts, then the frame cools.
      this.view.classList.add("releasing");
      window.setTimeout(() => this.view.classList.remove("releasing"), 400);
    }
    this.applyPhase();
  }

  setUrl(raw: string | null): void {
    const short = shortUrl(raw) ?? raw ?? null;
    this.url = short;
    this.urlText.textContent = short ?? "Its computer";
    this.canvas.setAttribute("aria-label", screenLabel(this.phase, short));
    this.updateWaiting();
  }

  /** The overlay stands down once there is a page on screen worth showing. */
  private updateWaiting(): void {
    if (!this.opts.computerId) return; // "no computer to show" is the whole story
    const blank =
      this.url === null && (this.phase === "connecting" || this.phase === "paused");
    this.waiting.textContent = waitingCopy(
      this.phase,
      this.url,
      this.waitStage >= 1 ? NO_FRAME_HINT_MS : 0,
    );
    this.waiting.hidden =
      (this.hasFrame && !blank) || this.phase === "driving" || this.phase === "observing";
    this.syncNoFrameWatch();
  }

  private syncNoFrameWatch(): void {
    if (!this.opts.computerId || this.hasFrame || this.phase !== "connecting") {
      if (this.phase !== "offline" && this.reconnectBtn.textContent === "Restart the picture") {
        this.reconnectBtn.hidden = true;
        this.reconnectBtn.textContent = "Reconnect";
      }
      this.clearNoFrameWatch();
      return;
    }
    this.startNoFrameWatch();
  }

  private startNoFrameWatch(): void {
    if (!this.opts.computerId || this.hasFrame || this.waitTimer || this.waitStage >= 2) {
      return;
    }
    const delay = this.waitStage === 0 ? NO_FRAME_HINT_MS : NO_FRAME_RESTART_MS - NO_FRAME_HINT_MS;
    this.waitTimer = window.setTimeout(() => this.advanceNoFrameWait(), delay);
  }

  private advanceNoFrameWait(): void {
    this.waitTimer = 0;
    if (this.hasFrame || this.phase !== "connecting") return;
    this.waitStage = this.waitStage === 0 ? 1 : 2;
    if (this.waitStage === 2) {
      this.reconnectBtn.textContent = "Restart the picture";
      this.reconnectBtn.hidden = false;
      this.acts.hidden = false;
    }
    this.updateWaiting();
  }

  private clearNoFrameWatch(): void {
    window.clearTimeout(this.waitTimer);
    this.waitTimer = 0;
    this.waitStage = 0;
  }

  /**
   * Put the keyboard on the live surface. Called when control lands and again
   * from the driving card, which would otherwise keep the focus for itself.
   */
  focusScreen(): void {
    if (this.phase !== "driving") return;
    this.canvas.focus({ preventScroll: true });
  }

  getUrl(): string | null {
    return this.url;
  }

  setNote(text: string): void {
    this.noteText.textContent = text;
  }

  /** Hide the actions entirely on a finished task — never a dead control. */
  setActionsVisible(take: boolean, full: boolean): void {
    this.takeBtn.hidden = !take;
    this.fullBtn.hidden = !full;
    this.acts.hidden = !take && !full && this.reconnectBtn.hidden && this.returnBtn.hidden;
  }

  setTakeLabel(text: string, primary: boolean): void {
    this.takeBtn.replaceChildren(icon("hand"), document.createTextNode(text));
    this.takeBtn.className = primary ? "btn primary" : "btn";
  }

  setTakeBusy(busy: boolean): void {
    this.takeBtn.disabled = busy;
  }

  /**
   * Full screen, the browser's if it will have it.
   *
   * "Full screen" to a person means the whole display, not a bigger rectangle
   * inside a window, so the Fullscreen API is asked first — every path here
   * starts at a click, which is the user gesture it requires. A browser that
   * refuses it, or has not got it, gets the in-page full-bleed layout, which
   * looks the same inside the window.
   */
  async setFullScreen(full: boolean): Promise<void> {
    this.fullScreenDeny = null;
    if (full) {
      this.applyFullScreen(true);
      try {
        const request = this.root.requestFullscreen?.();
        if (request) await request;
      } catch (error) {
        const raw = error instanceof Error ? error.message.trim() : "";
        this.fullScreenDeny = raw && raw.length < 120 && !/[\r\n]/.test(raw) ? raw : "";
      }
      this.focusScreen();
      return;
    }
    this.applyFullScreen(false);
    if (document.fullscreenElement === this.root) {
      try {
        await document.exitFullscreen();
      } catch {
        // Already leaving; `fullscreenchange` settles the flag either way.
      }
    }
    this.focusScreen();
  }

  isFullScreen(): boolean {
    return this.full;
  }

  /** Browser Fullscreen API refusal; in-page full-bleed is already on. */
  fullScreenDeniedDetail(): string | null {
    return this.fullScreenDeny;
  }

  private applyFullScreen(full: boolean): void {
    this.full = full;
    this.fullBtn.textContent = full ? "Leave full screen" : "Full screen";
    this.applyChrome();
    this.opts.onFullScreen?.(full);
  }

  /** Driving full screen is the one state with no chrome but the slim bar. */
  private applyChrome(): void {
    const bare = this.full && this.phase === "driving";
    this.root.classList.toggle("driving-full", bare);
    this.driveBar.hidden = !bare;
    this.googleBtn.hidden = this.phase !== "driving";
    if (bare) this.driveBar.append(this.googleBtn);
    else if (this.phase === "driving") this.acts.append(this.googleBtn);
    else this.driveBar.append(this.googleBtn);
  }

  private applyPhase(): void {
    const copy = phaseCopy(this.phase);
    this.stateText.textContent = copy.state;
    this.noteText.textContent = copy.note;
    this.urlDot.className = copy.dot;
    this.screen.classList.toggle("dim", copy.dim);
    const driving = this.phase === "driving";
    this.view.classList.toggle("human", driving);
    // Not a tab stop while the bot drives (§7); focusable the moment you are.
    this.canvas.tabIndex = driving ? 0 : -1;
    // `application` tells the AX layer to stop intercepting keys and hand them
    // to the element — which is the whole point while a person is driving. Off
    // again the moment they are not, so the bot's screen stays a picture.
    this.canvas.setAttribute("role", driving ? "application" : "img");
    this.canvas.setAttribute("aria-label", screenLabel(this.phase, this.url));
    this.hintText.hidden = !driving;
    this.returnBtn.hidden = this.phase !== "paused" && this.phase !== "driving";
    this.applyChrome();
    this.updateWaiting();
    if (driving) this.canvas.focus({ preventScroll: true });
  }
}
