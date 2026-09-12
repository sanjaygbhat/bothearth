/**
 * native.ts — the one seam between this web UI and the native macOS shell, and
 * the "your bot needs you" attention loop.
 *
 * The contract is mirrored in apps/macos/README.md — change both or neither.
 *
 * Page → shell is `window.webkit.messageHandlers.modelbot.postMessage({method, args})`.
 * `webkit.messageHandlers` exists regardless of the page’s CSP, so this module
 * is served same-origin like any other and nothing is injected with
 * `WKUserScript` — `script-src 'self'` stays intact.
 *
 *   setBadge(n)                  dock badge = things waiting on a person
 *   notify(title, body, route)   a banner; `route` comes back on click
 *   setTitle(text)               window title
 *   openExternal(url)            http(s) only, and never our own origin
 *   requestAttention(critical)   one dock bounce
 *   setAttention(waiting)        how many things are waiting on a person, so
 *                                the menu-bar item can say "Waiting for you"
 *   revealFile({...})            show a file the bot saved, in Finder or as a
 *                                download — NEVER by navigating the app to it
 *
 * Shell → page is a single channel: the shell evaluates
 * `dispatchEvent(new CustomEvent("modelbot:native", {detail}))`. `detail.kind`
 * is one of the kinds in `NativeEventKind`; `detail.route`, if present, is
 * treated by shell.ts exactly like a hash change.
 *
 * Everything degrades in a plain browser. Gate on `modelbotNative.isNative`,
 * never on the user agent — the same bundle is Safari, the remote HTTPS client
 * and the phone WebView’s control surface.
 */

import { apiGet } from "./api.ts";
import { navigate } from "./shell.ts";
import {
  DesktopAlerts,
  desktopAlerts,
  dismissAlertsPrompt,
  promptForAlerts,
  type Ping,
} from "./takeover-pings.ts";

/* -------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------- */

export type NativeEventKind =
  | "notification-click"
  /** ⌘[ or the error state's Back button, with no shell history left to walk. */
  | "back"
  /** A `notify` the shell could not deliver, named by `notifyId`. */
  | "notify-failed"
  | "focus"
  | "open-settings"
  | "new-task"
  | "open-palette"
  | "open-keys";

export interface NativeEventDetail {
  kind?: NativeEventKind;
  /** Hash route to open. shell.ts routes on this; we route on it too. */
  route?: string;
  /** Set on `notification-click`. May itself be a hash route. */
  taskId?: string;
  /** Set on `notify-failed`: the `key` of the ping that was not shown. */
  notifyId?: string;
}

export interface ModelBotNative {
  /** True only inside the Mac shell. Never sniff the user agent instead. */
  readonly isNative: boolean;
  setBadge(count: number): void;
  notify(title: string, body: string, route?: string): void;
  setTitle(text: string): void;
  /** Returns false when the URL is refused (same-origin, or not http/https). */
  openExternal(url: string): boolean;
  requestAttention(critical?: boolean): void;
  /** How many things are waiting on a person right now. */
  setAttention(waiting: number): void;
  /**
   * Show a file the bot saved. In the Mac shell this reveals it in Finder when
   * the daemon said where it landed (`results_dir`), and downloads it through
   * the app's own session otherwise. In a browser it opens in a new tab.
   *
   * Never a top-level navigation to an API URL: the shell would load it into
   * the one web view and the app would be replaced by the response body.
   */
  revealFile(target: RevealTarget): boolean;
}

export interface RevealTarget {
  /** Same-origin URL that serves the file. Required. */
  url: string;
  /** Workspace-relative path, as the receipt recorded it. */
  path?: string | null;
  /** Where the daemon put this run's output on this Mac, when it says. */
  resultsDir?: string | null;
}

type BridgeHandler = { postMessage(message: unknown): void };

declare global {
  interface Window {
    webkit?: { messageHandlers?: Record<string, BridgeHandler | undefined> };
    modelbotNative?: ModelBotNative;
  }
}

/* -------------------------------------------------------------------------
 * The bridge
 * ---------------------------------------------------------------------- */

function handler(): BridgeHandler | null {
  if (typeof window === "undefined") return null;
  const found = window.webkit?.messageHandlers?.["modelbot"];
  return found && typeof found.postMessage === "function" ? found : null;
}

function post(method: string, args: unknown): boolean {
  const bridge = handler();
  if (!bridge) return false;
  try {
    bridge.postMessage({ method, args });
    return true;
  } catch {
    // A shell that has torn the handler down must not take the page with it.
    return false;
  }
}

/**
 * Browser fallback for `setBadge`: the tab title carries the count.
 * shell.ts owns `document.title`, so rather than fight it we re-apply the
 * prefix whenever the title changes underneath us.
 */
let badgeCount = 0;
let titleObserver: MutationObserver | null = null;
let writingTitle = false;

function stripBadge(title: string): string {
  return title.replace(/^\(\d+\)\s*/, "");
}

function applyTabBadge(): void {
  if (typeof document === "undefined") return;
  const base = stripBadge(document.title);
  // The title already carries "● Needs you" whenever anything is waiting, and
  // "(1) ● Needs you" says the same thing twice. The count is the fallback for
  // a title that is NOT already saying it.
  const wanted = badgeCount > 0 && !base.startsWith("● ") ? `(${badgeCount}) ${base}` : base;
  if (document.title === wanted) return;
  writingTitle = true;
  document.title = wanted;
  writingTitle = false;
}

function watchTitle(): void {
  if (titleObserver || typeof MutationObserver === "undefined") return;
  const node = document.querySelector("title");
  if (!node) return;
  titleObserver = new MutationObserver(() => {
    if (!writingTitle) applyTabBadge();
  });
  titleObserver.observe(node, { childList: true, characterData: true, subtree: true });
}

/** http(s) only, and never our own origin — the setup link lives there. */
export function externalUrl(raw: string): URL | null {
  if (typeof raw !== "string" || raw === "") return null;
  let url: URL;
  try {
    url = new URL(raw, typeof location === "undefined" ? undefined : location.href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (typeof location !== "undefined" && url.origin === location.origin) return null;
  return url;
}

export const modelbotNative: ModelBotNative = {
  get isNative(): boolean {
    return handler() !== null;
  },

  setBadge(count: number): void {
    const n = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
    badgeCount = n;
    if (post("setBadge", n > 0 ? String(n) : null)) return;
    applyTabBadge();
    watchTitle();
  },

  notify(title: string, body: string, route?: string): void {
    const ping: Ping = { key: `notify:${route ?? title}`, title, body, route: route ?? "#/" };
    if (post("notify", { id: ping.key, title, body, taskId: route ?? null })) {
      unshown.push(ping);
      if (unshown.length > UNSHOWN_LIMIT) unshown.shift();
      return;
    }
    desktopAlerts.once(ping);
  },

  setTitle(text: string): void {
    if (post("setTitle", text)) return;
    if (typeof document !== "undefined") document.title = text || "BotHearth";
  },

  openExternal(url: string): boolean {
    const target = externalUrl(url);
    if (!target) return false;
    if (post("openExternal", target.href)) return true;
    window.open(target.href, "_blank", "noopener,noreferrer");
    return true;
  },

  requestAttention(critical = true): void {
    post("requestAttention", { critical });
  },

  setAttention(waiting: number): void {
    const n = Number.isFinite(waiting) && waiting > 0 ? Math.trunc(waiting) : 0;
    post("setAttention", { waiting: n });
  },

  revealFile(target: RevealTarget): boolean {
    const raw = typeof target?.url === "string" ? target.url : "";
    if (raw === "") return false;
    let href: string;
    try {
      href = new URL(raw, typeof location === "undefined" ? undefined : location.href).href;
    } catch {
      return false;
    }
    if (
      post("revealFile", {
        url: href,
        path: target.path ?? null,
        resultsDir: target.resultsDir ?? null,
      })
    ) {
      return true;
    }
    // A browser has no Finder. A new tab is the honest equivalent, and the
    // daemon sends `Content-Disposition: attachment`, so it downloads rather
    // than replacing anything.
    if (typeof window === "undefined") return false;
    window.open(href, "_blank", "noopener,noreferrer");
    return true;
  },
};

if (typeof window !== "undefined") window.modelbotNative = modelbotNative;

/**
 * Pings handed to the shell that macOS may not have shown. Posting one always
 * succeeds; delivering it does not — an ad-hoc signed bundle is refused
 * notification authorization outright — so the shell answers the ones it could
 * not deliver and the page falls back to its own alert. Bounded because the
 * bridge drops anything past 3 notifications in 3 seconds without answering.
 */
const UNSHOWN_LIMIT = 4;
const unshown: Ping[] = [];

/* -------------------------------------------------------------------------
 * Shell → page: a typed bus over the one `modelbot:native` event.
 * shell.ts already handles `detail.route`; this is for everything else.
 * ---------------------------------------------------------------------- */

type NativeListener = (detail: NativeEventDetail) => void;

const listeners = new Map<string, Set<NativeListener>>();
let busInstalled = false;

function installBus(): void {
  if (busInstalled || typeof window === "undefined") return;
  busInstalled = true;
  window.addEventListener("modelbot:native", (event) => {
    const detail = (event as CustomEvent<NativeEventDetail>).detail ?? {};
    for (const listener of listeners.get(detail.kind ?? "") ?? []) listener(detail);
    for (const listener of listeners.get("*") ?? []) listener(detail);
  });
}

/**
 * Subscribe to one shell event kind, or `"*"` for all of them.
 * Returns an unsubscribe function.
 */
export function onNative(kind: NativeEventKind | "*", listener: NativeListener): () => void {
  installBus();
  const set = listeners.get(kind) ?? new Set<NativeListener>();
  set.add(listener);
  listeners.set(kind, set);
  return () => {
    set.delete(listener);
  };
}

onNative("notify-failed", (detail) => {
  const index = unshown.findIndex((ping) => ping.key === detail.notifyId);
  if (index < 0) return;
  const [ping] = unshown.splice(index, 1);
  if (ping) desktopAlerts.once(ping);
});

// The shell's Back gesture, once it has run out of history of its own. The
// titlebar's Back button is the page's own answer to the same question.
onNative("back", () => {
  if (typeof document === "undefined") return;
  const button = document.getElementById("tb-back") as HTMLButtonElement | null;
  if (button && !button.hidden) button.click();
  else navigate("#/");
});

/** `taskId` from a notification may already be a route; accept either form. */
export function routeFromNotification(detail: NativeEventDetail): string | null {
  if (typeof detail.route === "string" && detail.route.startsWith("#/")) return detail.route;
  const taskId = detail.taskId;
  if (typeof taskId !== "string" || taskId === "") return null;
  return taskId.startsWith("#/") ? taskId : `#/tasks/${taskId}`;
}

/* -------------------------------------------------------------------------
 * The "your bot needs you" loop
 *
 * One owner, end to end. It watches the event stream itself rather than being
 * fed by a view, so the badge and the alert are correct on every screen — and
 * on no screen at all, when the window is in the background, which is exactly
 * when this matters. `takeover-pings.ts` is the browser output half.
 * ---------------------------------------------------------------------- */

export type AttentionKind = "approval" | "takeover";

export interface AttentionItem {
  /** Approval or takeover id — the dedup identity. */
  id: string;
  kind: AttentionKind;
  taskId: string | null;
  /** ISO timestamp; the item stops counting when it passes. */
  expiresAt?: string;
}

/**
 * Deliberately generic. A desktop banner is visible to anyone walking past the
 * machine, so it says that something needs a person and nothing about what.
 */
function copyFor(kind: AttentionKind): { title: string; body: string } {
  return kind === "takeover"
    ? {
        title: "Your bot needs you.",
        body: "Open BotHearth and take control. The login is in the bot's browser, not in Arc.",
      }
    : {
        title: "Your bot needs you.",
        body: "It’s waiting for your OK before it goes ahead.",
      };
}

function pingFor(item: AttentionItem): Ping {
  const { title, body } = copyFor(item.kind);
  return {
    key: `${item.kind}:${item.id}`,
    title,
    body,
    route: item.taskId ? `#/tasks/${item.taskId}` : "#/",
  };
}

const ANNOUNCE_LIMIT = 100;
const RECONNECT_MS = 1000;
const SETTLE_MS = 120;

class Attention {
  private announced: string[] = [];
  private items: AttentionItem[] = [];
  private ws: WebSocket | null = null;
  private reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  private running = false;
  private readonly subscribers = new Set<(items: AttentionItem[]) => void>();

  /** How many things are waiting on a person right now. */
  count(): number {
    return this.items.length;
  }

  pending(): AttentionItem[] {
    return [...this.items];
  }

  /** Views that want to mirror the count (a titlebar chip, say). */
  subscribe(listener: (items: AttentionItem[]) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /**
   * Reconcile the whole set. Idempotent: calling it with the same items twice
   * announces once. Entering the set notifies, bounces the dock and raises the
   * badge; leaving it lowers the badge and closes a banner nobody needs.
   */
  sync(items: AttentionItem[]): void {
    const now = Date.now();
    const live = items.filter(
      (item) => !item.expiresAt || Number.isNaN(Date.parse(item.expiresAt)) || Date.parse(item.expiresAt) > now,
    );
    this.items = live;

    const fresh = live.filter((item) => !this.announced.includes(pingFor(item).key));
    modelbotNative.setBadge(live.length);
    // The badge alone cannot tell the shell WHY it is set, and the menu-bar item
    // must not read "Working" while the bot is stopped and waiting on a person.
    modelbotNative.setAttention(live.length);

    if (modelbotNative.isNative) {
      for (const item of fresh) {
        const ping = pingFor(item);
        modelbotNative.notify(ping.title, ping.body, ping.route);
      }
      // The native shell owns the banner; a browser banner would double up.
      desktopAlerts.closeAll();
    } else {
      desktopAlerts.announce(live.map(pingFor));
      // Ask for permission the first time it would actually have been used,
      // and only then. Never on load, never as a permanent footer button.
      if (fresh.length > 0 && !DesktopAlerts.asked()) promptForAlerts();
      if (live.length === 0) dismissAlertsPrompt();
    }

    if (fresh.length > 0) {
      modelbotNative.requestAttention(true);
      this.remember(fresh.map((item) => pingFor(item).key));
      const takeover = fresh.find((item) => item.kind === "takeover" && item.taskId);
      const active = typeof document === "undefined" ? null : document.activeElement;
      const typing =
        active != null &&
        active !== document.body &&
        (active as HTMLElement).id !== "home-goal" &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          Boolean((active as HTMLElement).isContentEditable));
      const route = takeover?.taskId ? `#/tasks/${takeover.taskId}` : null;
      if (route && !typing && location.hash !== route) {
        navigate(route);
      }
    }

    this.scheduleExpiry(live);
    for (const listener of this.subscribers) listener([...live]);
  }

  /** Nothing is waiting any more. */
  clear(): void {
    this.sync([]);
  }

  /**
   * Watch `WS /api/v1/events` and keep the set true. Returns a stop function.
   * Idempotent — a second call returns the same stopper without a second socket.
   */
  start(): () => void {
    if (this.running) return () => this.stop();
    this.running = true;
    desktopAlerts.armOnFirstGesture();
    this.connect();
    return () => this.stop();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.reconcileTimer);
    clearTimeout(this.expiryTimer);
    this.revision += 1;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      // Already closing.
    }
  }

  private connect(): void {
    if (!this.running || typeof WebSocket === "undefined") return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}//${location.host}/api/v1/events`);
    } catch {
      return;
    }
    this.ws = ws;
    ws.addEventListener("open", () => {
      if (this.ws === ws) this.queueReconcile(0);
    });
    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let type = "";
      try {
        type = (JSON.parse(event.data) as { type?: unknown }).type as string;
      } catch {
        return;
      }
      if (typeof type !== "string") return;
      if (type.startsWith("approval.") || type.startsWith("takeover.") || type.startsWith("task.")) {
        this.queueReconcile(SETTLE_MS);
      }
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws || !this.running) return;
      this.ws = null;
      setTimeout(() => {
        if (this.running && this.ws === null) this.connect();
      }, RECONNECT_MS);
    });
  }

  private queueReconcile(delay: number): void {
    clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => {
      void this.reconcile();
    }, delay);
  }

  /**
   * The event only says "something changed"; the two lists say what is true.
   * Reading them is also what makes a reload, a reconnect and a second tab all
   * agree without any of them replaying old announcements.
   */
  async reconcile(): Promise<void> {
    const revision = ++this.revision;
    let approvals: ApprovalRow[];
    let takeovers: TakeoverRow[];
    try {
      const [a, t] = (await Promise.all([
        apiGet("/api/v1/approvals"),
        apiGet("/api/v1/takeovers"),
      ])) as [{ approvals?: ApprovalRow[] }, { takeovers?: TakeoverRow[] }];
      approvals = a.approvals ?? [];
      takeovers = t.takeovers ?? [];
    } catch {
      // The window’s own connection banner reports this; the badge holds.
      return;
    }
    if (revision !== this.revision) return;
    const items = [...attentionFromApprovals(approvals), ...attentionFromTakeovers(takeovers)];
    // The task itself is the authority on whether it is still waiting on
    // anyone: an approval or a takeover row can outlive the task that raised
    // it (a timeout fails the task without anyone ever deciding the row), and
    // a banner that survives the task it was about is a bug on its own.
    let tasks: TaskStatusRow[] = [];
    try {
      tasks = ((await apiGet("/api/v1/tasks")) as { tasks?: TaskStatusRow[] }).tasks ?? [];
    } catch {
      // Filtering just does less this round; the rows above still stand.
    }
    if (revision !== this.revision) return;
    this.sync(liveAttention(items, tasks));
  }

  private remember(keys: string[]): void {
    this.announced = [...this.announced, ...keys].slice(-ANNOUNCE_LIMIT);
  }

  /** An expiring request clears itself; the daemon need not send an event. */
  private scheduleExpiry(items: AttentionItem[]): void {
    clearTimeout(this.expiryTimer);
    const soonest = items
      .map((item) => (item.expiresAt ? Date.parse(item.expiresAt) : Number.NaN))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b)[0];
    if (soonest === undefined) return;
    const wait = Math.max(250, soonest - Date.now() + 250);
    this.expiryTimer = setTimeout(() => this.sync(this.items), wait);
  }
}

type ApprovalRow = {
  id: string;
  task_id?: string | null;
  status: string;
  bind_json?: string;
};

type TakeoverRow = {
  id: string;
  task_id?: string | null;
  state: string;
  expires_at?: string;
};

/** Pending, un-expired approvals. The expiry lives inside `bind_json`. */
export function attentionFromApprovals(rows: ApprovalRow[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const row of rows) {
    if (row.status !== "pending") continue;
    let expiresAt: string | undefined;
    try {
      const bind = JSON.parse(row.bind_json ?? "{}") as { expires?: unknown };
      if (typeof bind.expires === "string") expiresAt = bind.expires;
    } catch {
      // A row we cannot read still counts — failing closed means the person
      // is told about something rather than silently not told.
    }
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) continue;
    items.push({ id: row.id, kind: "approval", taskId: row.task_id ?? null, ...(expiresAt ? { expiresAt } : {}) });
  }
  return items;
}

/**
 * Only `takeover_requested` needs a person. `human` means they are already
 * driving, and the rest are the machine settling — none of those is an ask.
 */
export function attentionFromTakeovers(rows: TakeoverRow[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const row of rows) {
    if (row.state !== "takeover_requested") continue;
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) continue;
    items.push({
      id: row.id,
      kind: "takeover",
      taskId: row.task_id ?? null,
      ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    });
  }
  return items;
}

type TaskStatusRow = { id: string; status: string };

const TASK_OVER = new Set(["completed", "failed", "cancelled"]);

/**
 * Drop anything whose own task has already ended. The daemon closes out a
 * takeover once its task finishes (`store.ts` `setTaskStatus`), but an
 * approval opened by a different reason than the one that ended the task can
 * still be sitting there unanswered and unexpired — and either way, a row
 * this page has not yet learned about is safer read as still live than
 * silently dropped, which is what the empty-`tasks` early return is for.
 */
export function liveAttention(items: AttentionItem[], tasks: TaskStatusRow[]): AttentionItem[] {
  if (!tasks.length) return items;
  const over = new Set(tasks.filter((t) => TASK_OVER.has(t.status)).map((t) => t.id));
  return items.filter((item) => !item.taskId || !over.has(item.taskId));
}

export const attention = new Attention();
