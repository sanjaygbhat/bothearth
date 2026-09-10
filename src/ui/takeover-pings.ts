/**
 * Desktop alerts in a plain browser — the fallback half of the "your bot needs
 * you" loop.
 *
 * In the Mac app this file does nothing: `native.ts` posts `notify` over the
 * bridge and macOS owns the banner. In Safari, on a phone, or behind the remote
 * HTTPS link there is no bridge, so the same attention events land here and
 * become Web Notifications.
 *
 * Two rules:
 *   1. Operator-only content. Never put page, task or request text on the
 *      desktop — a notification is visible to anyone walking past the machine.
 *   2. One ping per request, ever. Reconnects, polling and reloads must not
 *      repeat it, so the dedup set is persisted for the tab.
 *
 * Nothing is asked of the person until the first time a task actually needs
 * alerts, and then it is asked once, in place — and never again if they say no.
 */

import { toast } from "./shell.ts";

/** One thing waiting on a person. `key` is the dedup identity, stable per request. */
export interface Ping {
  key: string;
  title: string;
  body: string;
  /** Hash route the notification opens, e.g. `#/tasks/t_123`. */
  route: string;
}

export type AlertsPermission = "unsupported" | "default" | "granted" | "denied";

const SEEN_KEY = "modelbot.takeover-pings.seen";
const ASKED_KEY = "modelbot.alerts.asked";
const SEEN_LIMIT = 100;

function permissionOf(): AlertsPermission {
  if (typeof Notification === "undefined") return "unsupported";
  const value = Notification.permission;
  return value === "granted" || value === "denied" ? value : "default";
}

export class DesktopAlerts {
  private seen = new Set<string>();
  private open = new Map<string, Notification>();
  private live = new Set<string>();
  private audio: AudioContext | null = null;
  private gestureBound = false;

  constructor() {
    try {
      const stored = JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "[]") as unknown;
      if (Array.isArray(stored)) this.seen = new Set(stored.filter((v): v is string => typeof v === "string"));
    } catch {
      // Storage may be disabled; in-memory dedup still holds for this page.
    }
  }

  permission(): AlertsPermission {
    return permissionOf();
  }

  /**
   * Browsers only allow `requestPermission` and `AudioContext.resume` from a
   * user gesture, so the first click or keypress in the window arms both.
   * Idempotent; safe to call from anywhere.
   */
  armOnFirstGesture(): void {
    if (this.gestureBound || typeof window === "undefined") return;
    this.gestureBound = true;
    const unlock = () => this.unlockSound();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
  }

  unlockSound(): void {
    try {
      this.audio ??= new AudioContext();
      void this.audio.resume().catch(() => {});
    } catch {
      // The visible alert remains available without audio support.
    }
  }

  async request(): Promise<AlertsPermission> {
    if (permissionOf() !== "default") return permissionOf();
    this.unlockSound();
    try {
      await Notification.requestPermission();
    } catch {
      // Some browsers reject rather than resolve; the state below is still true.
    }
    return permissionOf();
  }

  /** True once the person has been asked, whatever they answered. */
  static asked(): boolean {
    if (permissionOf() !== "default") return true;
    try {
      return localStorage.getItem(ASKED_KEY) === "1";
    } catch {
      return false;
    }
  }

  static markAsked(): void {
    try {
      localStorage.setItem(ASKED_KEY, "1");
    } catch {
      // A tab that cannot remember will ask once more next time. Acceptable.
    }
  }

  /**
   * Reconcile the full set of things waiting on a person.
   * New keys chime and (with permission) notify; keys that have gone away
   * close their banner, because a request that has already been answered must
   * not sit on the desktop pretending it still needs an answer.
   */
  announce(pings: Ping[]): void {
    const next = new Map(pings.map((ping) => [ping.key, ping]));
    this.live = new Set(next.keys());

    for (const [key, notice] of this.open) {
      if (next.has(key)) continue;
      try {
        notice.close();
      } catch {
        // Already dismissed by the OS.
      }
      this.open.delete(key);
    }

    for (const ping of next.values()) {
      const notice = this.post(ping, () => this.live.has(ping.key));
      if (notice) this.open.set(ping.key, notice);
    }
  }

  /**
   * A single announcement that is not part of the pending set — "Done in four
   * minutes", say. Deduped by key like everything else, so a reload cannot
   * repeat it, but it is never reconciled away.
   */
  once(ping: Ping): void {
    this.post(ping, () => true);
  }

  /** Chime, then raise one banner if the browser allows it. */
  private post(ping: Ping, stillWanted: () => boolean): Notification | null {
    if (this.seen.has(ping.key)) return null;
    this.remember(ping.key);
    this.chime();
    if (permissionOf() !== "granted") return null;
    try {
      const notice = new Notification(ping.title, {
        body: ping.body,
        tag: `modelbot-${ping.key}`,
        silent: true,
      });
      notice.onclick = () => {
        try {
          notice.close();
        } catch {
          // Already gone.
        }
        window.focus();
        // A request that has since been answered must not yank the person to a
        // stale screen.
        if (stillWanted()) location.hash = ping.route;
      };
      return notice;
    } catch {
      // Blocked by the browser or the OS; the in-window card still shows it.
      return null;
    }
  }

  /** Drop every open banner — used when the page takes over the loop natively. */
  closeAll(): void {
    for (const notice of this.open.values()) {
      try {
        notice.close();
      } catch {
        // Already gone.
      }
    }
    this.open.clear();
    this.live.clear();
  }

  private remember(key: string): void {
    this.seen.add(key);
    // Bound the tab-local history without evicting anything still pending.
    const history = [...this.seen];
    this.seen = new Set(
      history.filter((id, index) => this.live.has(id) || index >= history.length - SEEN_LIMIT),
    );
    try {
      sessionStorage.setItem(SEEN_KEY, JSON.stringify([...this.seen]));
    } catch {
      // In-memory dedup still applies.
    }
  }

  private chime(): void {
    if (!this.audio || this.audio.state !== "running") return;
    try {
      const tone = this.audio.createOscillator();
      const volume = this.audio.createGain();
      const now = this.audio.currentTime;
      tone.frequency.value = 660;
      volume.gain.setValueAtTime(0, now);
      volume.gain.linearRampToValueAtTime(0.12, now + 0.02);
      volume.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      tone.connect(volume);
      volume.connect(this.audio.destination);
      tone.onended = () => {
        tone.disconnect();
        volume.disconnect();
      };
      tone.start(now);
      tone.stop(now + 0.32);
    } catch {
      // Visible alerts remain available if audio is suspended.
    }
  }
}

export const desktopAlerts = new DesktopAlerts();

/*
 * The contextual ask sits bottom-right, clear of the centred toast column and
 * of the approval card in the task column. It never steals focus: a person
 * mid-sentence in the task box must not lose their caret to it.
 */

const ASK_CSS = `
.mb-ask {
  position: fixed;
  right: var(--gutter-right);
  bottom: var(--space-md);
  z-index: var(--z-toast);
  width: min(340px, calc(100vw - var(--space-lg)));
  display: flex;
  flex-direction: column;
  gap: var(--space-2xs);
  padding: var(--space-sm);
  border-radius: var(--radius-lg);
  border: var(--hairline) solid var(--color-border);
  background: var(--color-elevated);
  box-shadow: var(--shadow-lg), var(--hairline-top);
  animation: mb-ask-in var(--dur-base) var(--ease-out-quart) both;
}
.mb-ask h2 {
  margin: 0;
  font-family: var(--font-ui);
  font-size: var(--text-body);
  line-height: var(--leading-heading);
  letter-spacing: var(--tracking-heading);
  font-weight: var(--weight-semibold);
  color: var(--color-text);
  text-wrap: pretty;
}
.mb-ask p {
  margin: 0;
  font-size: var(--text-ui);
  line-height: var(--leading-ui);
  color: var(--color-muted);
  max-width: none;
}
.mb-ask-row {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2xs);
  margin-top: var(--space-3xs);
}
@keyframes mb-ask-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: none; }
}
@media (max-width: 620px) {
  .mb-ask {
    right: var(--gutter-phone);
    left: var(--gutter-phone);
    width: auto;
  }
}
`;

let askSheet: CSSStyleSheet | null = null;

/**
 * A constructable stylesheet rather than a `.css` file: the page is served
 * under `style-src 'self'`, so an inline `<style>` would be refused, and CSSOM
 * sheets are exempt from CSP and need no build change.
 */
function ensureAskStyles(): void {
  if (askSheet || typeof CSSStyleSheet === "undefined") return;
  try {
    askSheet = new CSSStyleSheet();
    askSheet.replaceSync(ASK_CSS);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, askSheet];
  } catch {
    askSheet = null;
  }
}

let askCard: HTMLElement | null = null;

/** Take the ask off screen. Safe to call when nothing is showing. */
export function dismissAlertsPrompt(): void {
  askCard?.remove();
  askCard = null;
}

/**
 * Ask, once, at the moment it first matters. Returns true if the ask was put on
 * screen. No-op when notifications are unavailable, already decided, already
 * asked once, or already showing.
 */
export function promptForAlerts(): boolean {
  if (typeof document === "undefined" || !document.body) return false;
  if (askCard) return false;
  if (permissionOf() !== "default" || DesktopAlerts.asked()) return false;

  ensureAskStyles();
  DesktopAlerts.markAsked();

  const card = document.createElement("section");
  card.className = "mb-ask";
  card.setAttribute("role", "status");
  card.setAttribute("aria-labelledby", "mb-ask-title");

  const heading = document.createElement("h2");
  heading.id = "mb-ask-title";
  heading.textContent = "Want a heads-up when your bot needs you?";

  const body = document.createElement("p");
  body.textContent =
    "Get a desktop alert when a task needs you. Task details stay out of alerts.";

  const row = document.createElement("div");
  row.className = "mb-ask-row";

  const no = document.createElement("button");
  no.type = "button";
  no.className = "btn ghost";
  no.textContent = "Not now";
  no.addEventListener("click", () => dismissAlertsPrompt());

  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "btn primary";
  yes.textContent = "Turn on alerts";
  yes.addEventListener("click", () => {
    void desktopAlerts.request().then((permission) => {
      dismissAlertsPrompt();
      if (permission === "granted") toast("success", "Desktop alerts are on.");
      else if (permission === "denied") {
        toast(
          "info",
          "Alerts are blocked for this site. BotHearth still shows every request here in the window.",
        );
      }
    });
  });

  row.append(no, yes);
  card.append(heading, body, row);
  card.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    dismissAlertsPrompt();
  });
  document.body.append(card);
  askCard = card;
  return true;
}
