import type { LiveControlMessage, LiveModeMsg } from "../../protocol/live.ts";
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
  onMode?: (mode: LiveMode, reason?: string) => void;
  onFrame?: (header: ScreencastFrameHeader) => void;
  onError?: (err: Error) => void;
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
  private readonly onVisibility = () => {
    if (this.canvas.ownerDocument.hidden) this.disconnected();
    else this.connect();
  };
  private readonly onPageHide = () => this.disconnected();
  private readonly onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted && !this.canvas.ownerDocument.hidden) this.connect();
  };
  private readonly onWindowBlur = () => this.resetKeys();
  private viewport: ViewportLike = { w: 1280, h: 720, dpr: 1 };
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
    if (!driver) this.resetKeys();
    this.driver = driver;
    this.updateBanner();
  }

  /** Explicit operator text, never queued or replayed after a connection change. */
  sendText(text: string): boolean {
    if (!text || text.length > 16384 || !this.driver || !this.authorityKnown || !this.frameReady || this.mode !== "human" || this.ws?.readyState !== WebSocket.OPEN) return false;
    try { this.ws.send(encodeControlMessage({ v: 1, t: "text", epoch: this.epoch, text })); this.cb.onInput?.(); return true; }
    catch { this.disconnected(); return false; }
  }

  connect(): void {
    this.close();
    const doc = this.canvas?.ownerDocument;
    doc?.addEventListener("visibilitychange", this.onVisibility);
    doc?.defaultView?.addEventListener("pagehide", this.onPageHide);
    doc?.defaultView?.addEventListener("pageshow", this.onPageShow);
    if (doc?.hidden) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/api/v1/live/${encodeURIComponent(this.computerId)}`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
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
    this.disconnect();
    this.cb.onError?.(new Error("The picture stopped. Choose Reconnect to see its computer again. Nothing you typed while it was gone was sent."));
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
  }

  private clearFrame(): void {
    this.frameReady = false;
    this.canvas?.getContext?.("2d")?.clearRect?.(0, 0, this.canvas.width, this.canvas.height);
  }

  private disconnect(keepFrame = false): void {
    this.resetKeys();
    this.canvas?.ownerDocument?.defaultView?.removeEventListener("blur", this.onWindowBlur);
    const ws = this.ws;
    this.ws = null;
    this.authorityKnown = false;
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
    if (!this.authorityKnown || header.epoch !== this.epoch || header.mode !== this.mode) return;
    const ws = this.ws;
    const painted = await this.drawFrame(header.mime, payload);
    if (this.ws !== ws || header.epoch !== this.epoch || header.mode !== this.mode) return;
    if (painted) {
      this.viewport = header.viewport;
      this.frameReady = true;
      this.cb.onFrame?.(header);
    }
    this.ack(header.seq);
  }

  private onControl(msg: LiveControlMessage): void {
    if (msg.t === "error") {
      this.disconnected();
      return;
    }
    // Ordered server control messages are authoritative. A recreated computer
    // starts a new epoch sequence; frames may not change that authority.
    if (msg.t === "mode") {
      const m = msg as LiveModeMsg;
      if (this.mode !== m.mode || this.epoch !== m.epoch) this.clearFrame();
      this.authorityKnown = true;
      this.mode = m.mode;
      this.epoch = m.epoch;
      this.updateBanner();
      this.cb.onMode?.(m.mode, m.reason);
      return;
    }
    if (msg.t === "hello") {
      this.clearFrame();
      this.authorityKnown = true;
      this.mode = msg.mode;
      this.epoch = msg.epoch;
      this.viewport = msg.viewport;
      this.updateBanner();
      this.cb.onMode?.(msg.mode);
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
    }, () => this.mode === mode && this.epoch === epoch && this.ws === ws);
  }

  private updateBanner(): void {
    const text = this.authorityKnown ? humanControlBanner(this.mode, this.driver) : "Not connected — nothing you type is sent";
    if (!this.banner) return;
    this.banner.textContent = text ?? "";
  }

  private bindInput(): void {
    const relayPointer = (
      kind: "move" | "down" | "up" | "wheel",
      ev: PointerEvent | WheelEvent,
      extra?: Record<string, number>,
    ): void => {
      if (!this.driver || !this.authorityKnown || !this.frameReady || !shouldRelayInput(this.mode)) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const rect = this.canvas.getBoundingClientRect();
      const { x, y } = mapClientToCssPx(
        ev.clientX,
        ev.clientY,
        rect,
        this.viewport,
      );
      const msg = buildPointerMessage(this.epoch, kind, x, y, extra);
      this.ws.send(encodeControlMessage(msg));
      this.cb.onInput?.();
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
    if (this.driver && this.authorityKnown && this.mode === "human" && this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(encodeControlMessage({ v: 1, t: "key", epoch: this.epoch, kind: "reset", key: "", code: "", mods: 0 })); }
      catch { /* A failed best-effort key reset must not prevent local cleanup. */ }
    }
  }

  /**
   * Keys this page keeps for itself while a person is driving, so the two
   * documented ways out of a takeover cannot be swallowed by the remote page.
   *
   * `Escape` returns control (the hint under the live view says so) and the
   * ⌘/Ctrl combinations are the app's own shortcuts — ⌘↩ gives control back,
   * ⌘. stops the task, ⌘⇧T toggles. Everything else, Tab and the arrows
   * included, belongs to the website the person is driving.
   */
  static keepsLocally(ev: KeyboardEvent): boolean {
    if (ev.key === "Escape") return true;
    return Boolean(ev.metaKey) || Boolean(ev.ctrlKey);
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
    if (LiveView.keepsLocally(ev)) return;
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
    this.cb.onInput?.();
  }
}
