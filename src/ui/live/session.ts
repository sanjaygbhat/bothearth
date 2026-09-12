import type { LiveControlMessage, LiveModeMsg, LivePointer } from "../../protocol/live.ts";
import {
  decodeControlMessage,
  decodeLiveFrame,
  encodeControlMessage,
  LIVE_FRAME_TYPE,
} from "../../protocol/live.ts";
import type { LiveMode, ScreencastFrameHeader } from "../../types/contracts.ts";
import {
  buildPointerMessage,
  humanControlBanner,
  mapClientToCssPx,
  shouldRelayInput,
  type ViewportLike,
} from "./coords.ts";

export type LiveViewCallbacks = {
  onConnecting?: () => void;
  onMode?: (mode: LiveMode, reason?: string) => void;
  onFrame?: (header: ScreencastFrameHeader) => void;
  onError?: (err: Error, recovery?: { held: boolean; tone?: "ok" | "warn" }) => void;
  /** An input actually went to the computer, which restarts the human's lease. */
  onInput?: () => void;
};

export type FrameCanvas = {
  width: number;
  height: number;
  getContext(id: "2d"): CanvasRenderingContext2D | null;
};

type BitmapLike = {
  width: number;
  height: number;
  close?: () => void;
};

/** Decode JPEG/PNG onto canvas: createImageBitmap when present, else Image(). */
export async function paintLiveFrame(
  canvas: FrameCanvas,
  mime: string,
  payload: Uint8Array,
  setObjectUrl?: (url: string | null) => void,
  canPaint: () => boolean = () => true,
): Promise<boolean> {
  const copy = new Uint8Array(payload.byteLength);
  copy.set(payload);
  const blob = new Blob([copy], { type: mime });
  const createBitmap = (
    globalThis as typeof globalThis & {
      createImageBitmap?: (source: Blob) => Promise<BitmapLike>;
    }
  ).createImageBitmap;
  if (typeof createBitmap === "function") {
    const bitmap = await createBitmap(blob);
    try {
      if (!canPaint()) return false;
      const ctx = canvas.getContext("2d");
      if (!ctx) return false;
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      ctx.drawImage(bitmap as CanvasImageSource, 0, 0);
      return true;
    } finally {
      bitmap.close?.();
    }
  }
  const url = URL.createObjectURL(blob);
  setObjectUrl?.(url);
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("frame decode failed"));
    img.src = url;
  });
  if (!canPaint()) return false;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  if (
    canvas.width !== img.naturalWidth ||
    canvas.height !== img.naturalHeight
  ) {
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
  }
  ctx.drawImage(img, 0, 0);
  return true;
}

/**
 * Canvas live view: draws JPEG/PNG frames from WS; relays pointer/touch/key
 * only while mode === "human".
 */
export class LiveView {
  readonly canvas: HTMLCanvasElement;
  readonly banner: HTMLElement;
  private ws: WebSocket | null = null;
  private mode: LiveMode = "agent";
  private epoch = 0;
  private authorityKnown = false;
  private frameReady = false;
  /**
   * Every window watching this computer is told the mode is `human`; only the
   * one that holds the grant may send. Starts closed, so a caller that never
   * says who is driving relays nothing.
   */
  private driver = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;
  private lastFrame = 0;
  private expiresAt = Number.POSITIVE_INFINITY;
  private expirySeenAt = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPointer: LivePointer | null = null;
  private producerBusy = false;
  private readonly onVisibility = () => {
    if (this.canvas.ownerDocument.hidden) { this.resetKeys(); this.clearFrame(); }
    else { this.lastPong = Date.now(); this.connect(); }
  };
  private readonly onPageHide = () => this.disconnect();
  private readonly onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted && !this.canvas.ownerDocument.hidden) this.connect();
  };
  private readonly onWindowBlur = () => this.resetKeys();
  private viewport: ViewportLike = { w: 1280, h: 720, dpr: 1 };
  private viewportEpoch = 0;
  private objectUrl: string | null = null;
  /** Identifies the ⌘V now in flight, so the two clipboard paths cannot both send. */
  private pasteToken: object | null = null;
  private readonly cb: LiveViewCallbacks;
  private readonly computerId: string;

  constructor(
    canvas: HTMLCanvasElement,
    banner: HTMLElement,
    computerId: string,
    cb: LiveViewCallbacks = {},
  ) {
    this.canvas = canvas;
    this.banner = banner;
    this.computerId = computerId;
    this.cb = cb;
    this.bindInput();
    this.updateBanner();
  }

  /** Does the person at this page hold the grant? Only they may send. */
  setDriver(driver: boolean): void {
    if (this.driver === driver) return;
    if (!driver) { this.resetKeys(); this.lastPointer = null; }
    this.driver = driver;
    this.updateBanner();
  }

  /** Latest `expires_at` from `mode` or `input_ack`, as epoch milliseconds. */
  leaseExpiresAt(): number | null {
    return Number.isFinite(this.expiresAt) ? this.expiresAt : null;
  }

  /** When that deadline was last taken from the server. */
  leaseSeenAt(): number | null {
    return this.expirySeenAt > 0 ? this.expirySeenAt : null;
  }

  /** CONNECTING or OPEN: do not tear down a live socket to re-learn the same grant. */
  private socketLive(): boolean {
    const state = this.ws?.readyState;
    return state === 0 || state === 1;
  }

  /** Explicit operator text, never queued or replayed after a connection change. */
  sendText(text: string): boolean {
    if (!text || text.length > 16384 || !this.driver || !this.authorityKnown || !this.frameReady || this.mode !== "human" || this.ws?.readyState !== WebSocket.OPEN) return false;
    try { this.ws.send(encodeControlMessage({ v: 1, t: "text", epoch: this.epoch, text })); return true; }
    catch { this.disconnected(); return false; }
  }

  connect(): void {
    this.listenToPage();
    if (this.canvas?.ownerDocument?.hidden) return;
    if (this.socketLive()) return;
    this.openSocket();
  }

  /** Tear down the socket and open a new one. The picture never arrived. */
  reconnect(): void {
    this.disconnect(true);
    this.connect();
  }

  private listenToPage(): void {
    const doc = this.canvas?.ownerDocument;
    doc?.removeEventListener("visibilitychange", this.onVisibility);
    doc?.addEventListener("visibilitychange", this.onVisibility);
    doc?.defaultView?.removeEventListener("pagehide", this.onPageHide);
    doc?.defaultView?.addEventListener("pagehide", this.onPageHide);
    doc?.defaultView?.removeEventListener("pageshow", this.onPageShow);
    doc?.defaultView?.addEventListener("pageshow", this.onPageShow);
  }

  private openSocket(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.resetKeys();
    const previous = this.ws;
    this.ws = null;
    this.authorityKnown = false;
    this.frameReady = false;
    this.producerBusy = false;
    this.updateBanner();
    previous?.close();
    this.cb.onConnecting?.();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/api/v1/live/${encodeURIComponent(this.computerId)}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.lastPong = Date.now();
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.canvas?.ownerDocument?.hidden) return;
      const now = Date.now();
      if (now - this.lastPong >= 1500) { this.disconnected(); return; }
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(encodeControlMessage({ v: 1, t: "ping" })); }
        catch { this.disconnected(); return; }
      }
      if (this.driver && this.frameReady && !this.producerBusy && now - this.lastFrame >= 1500) {
        this.resetKeys();
        this.frameReady = false;
        this.syncCursor();
        this.cb.onError?.(new Error("Waiting for a fresh picture… Input is paused."), { held: true });
      }
    }, 500);
    this.heartbeatTimer.unref?.();
    this.canvas?.ownerDocument?.defaultView?.addEventListener("blur", this.onWindowBlur);
    ws.addEventListener("message", (ev) => {
      if (this.ws !== ws) return;
      void this.onMessage(ev.data).catch(() => {
        if (this.ws === ws) this.disconnected();
      });
    });
    ws.addEventListener("error", () => {
      if (this.ws !== ws) return;
      this.disconnected();
    });
    ws.addEventListener("close", () => {
      if (this.ws === ws) this.disconnected();
    });
  }

  private disconnected(): void {
    const held = this.driver;
    this.disconnect(true);
    this.cb.onError?.(
      held
        ? new Error("Reconnecting…")
        : new Error("Connection interrupted. Reconnecting automatically. Nothing you type is sent until the picture returns."),
      { held },
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.canvas?.ownerDocument?.hidden) this.connect();
    }, 250);
  }

  /**
   * `keepFrame` leaves the last painted frame on the canvas. A live view must
   * never show a stale picture as if it were live, but a finished task's
   * receipt labels it "Last screen", where wiping it is the lie.
   */
  close(keepFrame = false): void {
    const doc = this.canvas?.ownerDocument;
    doc?.removeEventListener("visibilitychange", this.onVisibility);
    doc?.defaultView?.removeEventListener("pagehide", this.onPageHide);
    doc?.defaultView?.removeEventListener("pageshow", this.onPageShow);
    this.disconnect(keepFrame);
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.lastPointer = null;
  }

  private clearFrame(): void {
    this.frameReady = false;
    this.syncCursor();
    this.canvas?.getContext?.("2d")?.clearRect?.(0, 0, this.canvas.width, this.canvas.height);
  }

  private disconnect(keepFrame = false): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.resetKeys();
    this.canvas?.ownerDocument?.defaultView?.removeEventListener("blur", this.onWindowBlur);
    const ws = this.ws;
    this.ws = null;
    this.authorityKnown = false;
    this.producerBusy = false;
    if (keepFrame) this.frameReady = false;
    else this.clearFrame();
    this.updateBanner();
    ws?.close();
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  private async onMessage(data: unknown): Promise<void> {
    if (typeof data === "string") {
      this.onControl(decodeControlMessage(data));
      return;
    }
    if (!(data instanceof ArrayBuffer)) return;
    const u8 = new Uint8Array(data);
    if (u8.length < 5 || u8[0] !== LIVE_FRAME_TYPE) return;
    const { header, payload } = decodeLiveFrame(u8);
    if (this.canvas?.ownerDocument?.hidden) { this.ack(header.seq); return; }
    if (!this.authorityKnown || header.epoch !== this.epoch || header.mode !== this.mode || this.mode === "validating" ||
        (this.mode === "human" && Date.now() >= this.expiresAt)) { this.ack(header.seq); return; }
    const ws = this.ws;
    const resuming = !this.frameReady;
    const painted = await this.drawFrame(header.mime, payload);
    if (this.ws !== ws || header.epoch !== this.epoch || header.mode !== this.mode) return;
    if (painted) {
      this.viewport = header.viewport;
      this.viewportEpoch = header.epoch;
      this.frameReady = true;
      this.producerBusy = false;
      this.lastFrame = Date.now();
      this.syncCursor();
      this.cb.onFrame?.(header);
      if (resuming && this.driver && this.mode === "human" && this.lastPointer?.epoch === this.epoch && ws?.readyState === WebSocket.OPEN) {
        ws.send(encodeControlMessage(this.lastPointer));
      }
    }
    this.ack(header.seq);
  }

  private onControl(msg: LiveControlMessage): void {
    if (msg.t === "pong") { this.lastPong = Date.now(); return; }
    if (msg.t === "ping") {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeControlMessage({ v: 1, t: "pong" }));
      return;
    }
    if (msg.t === "input_ack") {
      if (this.driver && this.authorityKnown && this.mode === "human" && msg.epoch === this.epoch) {
        if (msg.expires_at) this.setExpiry(msg.expires_at);
        this.cb.onInput?.();
      }
      return;
    }
    if (msg.t === "error") {
      this.disconnected();
      return;
    }
    if (msg.t === "producer") {
      this.resetKeys();
      this.frameReady = false;
      this.producerBusy = true;
      this.syncCursor();
      if (msg.status === "restarting") {
        this.cb.onError?.(new Error("Restarting the picture…"), { held: true });
      } else {
        this.cb.onError?.(new Error("The picture stopped. Give control back and take it again."), { held: true, tone: "warn" });
      }
      return;
    }
    // Ordered server control messages are authoritative. A recreated computer
    // starts a new epoch sequence; frames may not change that authority.
    if (msg.t === "mode") {
      const m = msg as LiveModeMsg;
      if (this.mode !== m.mode || this.epoch !== m.epoch || m.mode === "validating") {
        this.clearFrame();
        this.lastPointer = null;
      }
      this.authorityKnown = true;
      this.mode = m.mode;
      this.epoch = m.epoch;
      this.producerBusy = false;
      this.setExpiry(m.expires_at);
      this.updateBanner();
      this.cb.onMode?.(m.mode, m.reason);
      return;
    }
    if (msg.t === "hello") {
      if (this.mode !== msg.mode || this.epoch !== msg.epoch) {
        this.clearFrame();
        this.lastPointer = null;
      }
      this.authorityKnown = true;
      this.mode = msg.mode;
      this.epoch = msg.epoch;
      this.viewport = msg.viewport;
      this.updateBanner();
      this.cb.onMode?.(msg.mode);
    }
  }

  private setExpiry(expiresAt?: string | null): void {
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    this.expiresAt = expiresAt ? Date.parse(expiresAt) : Number.POSITIVE_INFINITY;
    if (Number.isFinite(this.expiresAt)) this.expirySeenAt = Date.now();
    if (this.mode === "human" && Number.isFinite(this.expiresAt)) {
      this.expiryTimer = setTimeout(() => {
        this.expiryTimer = null;
        this.clearFrame();
        this.lastPointer = null;
        this.cb.onMode?.("validating");
      }, Math.max(0, this.expiresAt - Date.now()));
      this.expiryTimer.unref?.();
    }
  }

  private ack(seq: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeControlMessage({ v: 1, t: "frame_ack", seq }));
  }

  private async drawFrame(mime: string, payload: Uint8Array): Promise<boolean> {
    const { mode, epoch, ws } = this;
    return paintLiveFrame(this.canvas, mime, payload, (url) => {
      if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = url;
    }, () => !this.canvas?.ownerDocument?.hidden && this.mode === mode && this.epoch === epoch && this.ws === ws &&
      (mode !== "human" || Date.now() < this.expiresAt));
  }

  private updateBanner(): void {
    const text = this.authorityKnown
      ? humanControlBanner(this.mode, this.driver)
      : this.driver
        ? "Reconnecting…"
        : "Not connected — nothing you type is sent";
    if (this.banner) this.banner.textContent = text ?? "";
    this.syncCursor();
  }

  private syncCursor(): void {
    if (!this.canvas?.style) return;
    this.canvas.style.cursor = this.driver && this.authorityKnown && this.frameReady && this.mode === "human" ? "none" : "";
  }

  private bindInput(): void {
    const relayPointer = (
      kind: "move" | "down" | "up" | "wheel",
      ev: PointerEvent | WheelEvent,
      extra?: Record<string, number>,
    ): void => {
      if (!this.driver || !shouldRelayInput(this.mode) || this.canvas?.ownerDocument?.hidden) return;
      const rect = this.canvas.getBoundingClientRect();
      const { x, y } = mapClientToCssPx(
        ev.clientX,
        ev.clientY,
        rect,
        this.viewport,
      );
      const msg = buildPointerMessage(this.epoch, kind, x, y, extra);
      if (kind === "move" && this.viewportEpoch === this.epoch) this.lastPointer = buildPointerMessage(this.epoch, "move", x, y, { buttons: 0 });
      if (!this.authorityKnown || !this.frameReady || this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.send(encodeControlMessage(msg));
    };

    this.canvas.addEventListener("pointerdown", (ev) => {
      this.canvas.focus();
      this.canvas.setPointerCapture(ev.pointerId);
      relayPointer("down", ev, { button: ev.button, buttons: ev.buttons });
    });
    this.canvas.addEventListener("pointermove", (ev) => {
      relayPointer("move", ev, { buttons: ev.buttons });
    });
    this.canvas.addEventListener("pointerup", (ev) => {
      relayPointer("up", ev, { button: ev.button, buttons: ev.buttons });
    });
    this.canvas.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();
        relayPointer("wheel", ev, { deltaX: ev.deltaX, deltaY: ev.deltaY });
      },
      { passive: false },
    );

    this.canvas.addEventListener("blur", () => this.resetKeys());
    this.canvas.addEventListener("keydown", (ev) => this.onKey(ev, "keyDown"));
    this.canvas.addEventListener("keyup", (ev) => this.onKey(ev, "keyUp"));
    this.canvas.addEventListener("paste", (ev) => {
      if (!this.pasteToken) return;
      const text = (ev as ClipboardEvent).clipboardData?.getData("text/plain");
      if (!text) return;
      ev.preventDefault();
      this.pasteToken = null;
      this.sendText(text);
    });
  }

  /**
   * ⌘V / Ctrl+V while driving. `readText()` is the only path that works when
   * the browser gives the canvas no paste event of its own; the event's
   * `clipboardData` covers the rest, including a denied permission prompt.
   * Whichever arrives first wins, so one keystroke sends one paste.
   */
  private readPaste(): void {
    const token = {};
    this.pasteToken = token;
    const clipboard = navigator.clipboard;
    if (typeof clipboard?.readText !== "function") return;
    void clipboard.readText().then(
      (text) => {
        if (this.pasteToken !== token || !text) return;
        this.pasteToken = null;
        this.sendText(text);
      },
      () => {},
    );
  }

  private resetKeys(): void {
    this.pasteToken = null;
    if (this.driver && this.authorityKnown && this.mode === "human" && this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(encodeControlMessage({ v: 1, t: "key", epoch: this.epoch, kind: "reset", key: "", code: "", mods: 0 })); }
      catch { /* A failed best-effort key reset must not prevent local cleanup. */ }
    }
  }

  /** Reserve only BotHearth shortcuts; browser/desktop shortcuts go to the remote computer. */
  static keepsLocally(ev: KeyboardEvent): boolean {
    return Boolean(ev.metaKey || ev.ctrlKey) &&
      (ev.key === "Enter" || ev.key === "." || (Boolean(ev.shiftKey) && ev.key.toLowerCase() === "t"));
  }

  private onKey(ev: KeyboardEvent, kind: "keyDown" | "keyUp"): void {
    if (!this.driver || !this.authorityKnown || !this.frameReady || !shouldRelayInput(this.mode)) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const tag = (ev.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (kind === "keyDown" && (ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === "v") {
      this.readPaste();
      return;
    }
    // Let the app's own keys through to the document handler in task.ts.
    if (LiveView.keepsLocally(ev) || (ev.key === "Escape" && document.fullscreenElement)) return;
    // Tab in particular: without this it walks the app's own focus ring out of
    // the live surface and the next character lands in a button.
    ev.preventDefault();
    this.ws.send(
      encodeControlMessage({
        v: 1,
        t: "key",
        epoch: this.epoch,
        kind,
        code: ev.code,
        key: ev.key,
        text: ev.key.length === 1 ? ev.key : undefined,
        mods:
          (ev.altKey ? 1 : 0) |
          (ev.ctrlKey ? 2 : 0) |
          (ev.metaKey ? 4 : 0) |
          (ev.shiftKey ? 8 : 0),
      }),
    );
  }
}
