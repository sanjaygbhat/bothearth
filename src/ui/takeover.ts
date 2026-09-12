/**
 * Takeover — "your bot needs you" -> "you’re driving" -> back.
 *
 * The handoff animation lives in task.css (`.view.human`); this module owns the
 * copy, the state machine on the wire, and the two cards.
 *
 *   POST /api/v1/takeover/request           { computer_id, reason, task_id }
 *   POST /api/v1/takeover/:id/acquire       -> state human, new control epoch
 *   POST /api/v1/takeover/:id/release       -> agent, OR still human when the
 *                                              page is still sensitive
 *   POST /api/v1/takeover/:id/clear         -> about:blank, then release
 *   POST /api/v1/takeover/:id/decline
 *   POST /api/v1/takeover/:id/google-account -> Google account chooser, still human
 *
 * The epoch is never shown or named. Live input is authorised by the server’s
 * mode message, not by this optimistic UI: `LiveView` refuses to relay anything
 * until the server says `human`.
 */

import { apiPost, humanApiError } from "./api.ts";
import { countdownText } from "./needs-you.ts";
import { IS_APPLE } from "./palette.ts";
import { appendTextChild } from "./safe.ts";
import { toast } from "./shell.ts";

function modifierKey(): string {
  const platform = typeof navigator !== "undefined" ? navigator.platform || "" : "";
  if (platform) return IS_APPLE() ? "⌘" : "Ctrl";
  return "⌘";
}

export type TakeoverWire = {
  takeover_id: string;
  state: string;
  expires_at?: string;
  epoch?: number;
};

export type TakeoverRow = {
  id: string;
  computer_id: string;
  task_id?: string | null;
  state: string;
  expires_at?: string;
  /** Device id of the client the keyboard was granted to, when the daemon names it. */
  holder?: string | null;
};

/** States in which a person is being asked for, or already has, the keyboard. */
const ACTIVE_TAKEOVER_STATES = [
  "takeover_requested",
  "human",
  "resume_validating",
  "paused",
] as const;

export function isActiveTakeover(state: string): boolean {
  return (ACTIVE_TAKEOVER_STATES as readonly string[]).includes(state);
}

/**
 * Does the person at THIS page hold the keyboard?
 *
 * One grant, one holder — but every window watching that computer is told the
 * mode is `human`, so a page that only asked the server would say "You’re
 * driving" in all of them and relay input from all of them. The daemon names
 * the holder: on the grant itself (`holder`) and on `takeover.started`
 * (`actor`), both of them this browser's device id. A page that acquired the
 * grant itself knows without being told, and says so through `acquired`.
 *
 * Unknown holder means observer: never assume the keyboard is yours.
 */
export function isDriver(
  row: TakeoverRow | null,
  holder: string | null,
  self: { device: string | null; acquired: string | null },
): boolean {
  if (!row || row.state !== "human") return false;
  if (self.acquired === row.id) return true;
  return holder !== null && holder === self.device;
}

/**
 * The grant this tab acquired, across a reload of this tab.
 *
 * The daemon's durable step history drops `takeover.started`, so after a
 * reload a page cannot learn from the record that the keyboard is its own —
 * only that someone holds it. Session storage is per-tab, which is exactly the
 * scope of "I am driving"; the daemon's own holder outranks it either way.
 */
const ACQUIRED_KEY = "modelbot.control";

export function rememberAcquired(takeoverId: string | null): void {
  try {
    if (takeoverId) sessionStorage.setItem(ACQUIRED_KEY, takeoverId);
    else sessionStorage.removeItem(ACQUIRED_KEY);
  } catch {
    // No storage in this browser: the daemon's holder is the only answer.
  }
}

export function acquiredControl(): string | null {
  try {
    return sessionStorage.getItem(ACQUIRED_KEY);
  } catch {
    return null;
  }
}

/** The lease line under "You’re driving". */
export function leaseText(msLeft: number): string {
  return msLeft > 0
    ? `Control pauses in ${countdownText(msLeft)} unless you keep using it.`
    : "Control has paused. Take control again when you’re ready; the bot is waiting.";
}

/**
 * Why it stopped, in words. The wire reasons are the sensitive-surface
 * detectors on the computer side; none of those names reaches a person.
 *
 * The detectors guess, and they guess wrong: an `otp_field` fired on a Gmail
 * results page with a sort menu open and cost three and a half minutes. So the
 * sentence says what the bot THINKS it is looking at, and the card offers a way
 * to say it is wrong (`onDecline`) rather than only a way to agree.
 */
const REASONS: Record<string, string> = {
  password_field: "It thinks this is a password box, and it won’t type your password for you.",
  otp_field: "It thinks this is a one-time-code field, and only you have the code.",
  sign_in: "It thinks this is a sign-in page, and it won’t sign in as you.",
  webauthn_prompt: "It thinks this is a passkey or security-key prompt, which only you can answer.",
  captcha_iframe: "It thinks this is a “prove you’re human” check.",
  sensitive_page: "It thinks this is a page it shouldn’t touch without you.",
  model: "It hit a step it can’t do safely on its own.",
  ui: "You asked for the keyboard.",
};

export function takeoverReason(reason: string | undefined | null): string {
  const text = reason?.trim() ?? "";
  if (Object.hasOwn(REASONS, text)) return REASONS[text]!;
  // Unknown detector identifiers stay hidden. Prose is already bounded and redacted by the daemon.
  return text && !/^[a-zA-Z0-9_.:-]+$/.test(text)
    ? text.slice(0, 2000)
    : "The bot needs your help with this step.";
}

/** Release can come back still-human when the page is still sensitive. */
export const STILL_SENSITIVE =
  "That page still has a password or a code on it. Finish that step or move off it, then return control again.";

export const PASSWORD_STILL_ON_SCREEN =
  "The page still shows a password field. Navigate the bot's browser away from it (for example to about:blank), then give control back.";

export function blockedHoldCopy(kind?: string): string {
  if (kind === "otp") {
    return "The page still shows a code field. Navigate the bot's browser away from it (for example to about:blank), then give control back.";
  }
  return PASSWORD_STILL_ON_SCREEN;
}

export const CLEAR_AND_RETURN = "Clear the screen and give control back";

export const TAKE_FAILED =
  "Your bot is still finishing a step. Try again in a moment.";

/**
 * What the live view says the moment the keyboard lands on it.
 *
 * The frame marks human control and names the way back out.
 */
export const CONTROL_TAKEN =
  "You have control. Type and click in the frame as if it were your own computer. Press Give control back (⌘↩) when done.";

/**
 * Ask for the keyboard and take it. Returns the grant this page now holds, or
 * null when the daemon handed back one that is already human — that lease
 * belongs to whoever acquired it, which may not be this page.
 */
export async function requestControl(
  computerId: string,
  taskId?: string,
): Promise<TakeoverWire | null> {
  const response = (await apiPost("/api/v1/takeover/request", {
    computer_id: computerId,
    reason: "ui",
    ...(taskId ? { task_id: taskId } : {}),
  })) as { takeover: TakeoverWire };
  const takeover = response.takeover;
  if (takeover.state === "human") return null;
  await apiPost(
    `/api/v1/takeover/${encodeURIComponent(takeover.takeover_id)}/acquire`,
  );
  return takeover;
}

export type ReleaseResult =
  | { ok: true; cleared?: { reason: string } }
  | { ok: false; blocked_by?: { kind: string } };

function kindString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Reason the daemon named on a release: `cleared.reason`, else `blocked_by.kind`. */
export function releaseReasonFrom(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const row = payload as { cleared?: unknown; blocked_by?: unknown };
  const cleared = row.cleared;
  const fromCleared =
    cleared && typeof cleared === "object"
      ? kindString((cleared as { reason?: unknown }).reason)
      : undefined;
  const blocked = row.blocked_by;
  const fromBlocked =
    blocked && typeof blocked === "object"
      ? kindString((blocked as { kind?: unknown }).kind)
      : undefined;
  return fromCleared ?? fromBlocked;
}

/**
 * One line after control is returned. Only the reasons the daemon actually
 * sends are mapped; anything else is the no-reason sentence.
 */
export function releaseReturnedCopy(reason?: string | null): string {
  if (reason === "password") {
    return "You gave control back. The bot cleared the password field before continuing.";
  }
  if (reason === "otp") {
    return "You gave control back. The bot cleared the code field before continuing.";
  }
  if (reason === "expired") return "Control returned because the hold expired.";
  return "You gave control back.";
}

function releaseFrom(response: {
  takeover?: { state?: string };
  blocked_by?: { kind?: unknown };
  cleared?: { reason?: unknown };
}): ReleaseResult {
  const reason = releaseReasonFrom(response);
  if (response.takeover?.state !== "human") {
    return reason ? { ok: true, cleared: { reason } } : { ok: true };
  }
  return { ok: false, blocked_by: reason ? { kind: reason } : undefined };
}

/** Returns whether control actually went back to the bot. */
export async function releaseControl(takeoverId: string): Promise<ReleaseResult> {
  const response = (await apiPost(
    `/api/v1/takeover/${encodeURIComponent(takeoverId)}/release`,
  )) as {
    takeover?: { state?: string };
    blocked_by?: { kind?: unknown };
    cleared?: { reason?: unknown };
  };
  return releaseFrom(response);
}

/** Navigate the current tab to about:blank, then release. */
export async function clearAndReleaseControl(takeoverId: string): Promise<ReleaseResult> {
  const response = (await apiPost(`/api/v1/takeover/${encodeURIComponent(takeoverId)}/clear`)) as {
    takeover?: { state?: string };
    blocked_by?: { kind?: unknown };
    cleared?: { reason?: unknown };
  };
  return releaseFrom(response);
}

export async function declineControl(takeoverId: string): Promise<void> {
  await apiPost(`/api/v1/takeover/${encodeURIComponent(takeoverId)}/decline`);
}

export const SWITCH_GOOGLE_ACCOUNT = "Use a different Google account";

const GOOGLE_ACCOUNT_NEEDS_HOLD = "Take control first, then choose a different Google account.";

/** Open Google's account chooser in the bot's current tab. Human hold only. */
export async function switchGoogleAccount(takeoverId: string): Promise<void> {
  await apiPost(`/api/v1/takeover/${encodeURIComponent(takeoverId)}/google-account`);
}

function appendGoogleAccountButton(
  root: HTMLElement,
  acts: HTMLElement,
  armed: boolean,
): HTMLButtonElement {
  const google = document.createElement("button");
  google.type = "button";
  google.className = "btn ghost";
  google.textContent = SWITCH_GOOGLE_ACCOUNT;
  if (!armed) {
    google.disabled = true;
    google.setAttribute("title", GOOGLE_ACCOUNT_NEEDS_HOLD);
  } else {
    google.addEventListener("click", () => {
      const id = root.dataset.takeoverId || acquiredControl();
      if (!id) return;
      void switchGoogleAccount(id).catch((error: unknown) => {
        toast("warn", humanApiError(error, "Couldn’t open Google’s account chooser."));
      });
    });
  }
  acts.append(google);
  return google;
}

export interface NeedsYouHandlers {
  reason?: string | null;
  onTake(): void;
  onDecline?: () => void;
}

/** Step 1: the bot has stopped and is asking. */
export function renderNeedsYou(handlers: NeedsYouHandlers): {
  root: HTMLElement;
  focus(): void;
  setBusy(busy: boolean): void;
} {
  const root = document.createElement("section");
  // Not "needs-you": that class belongs to the titlebar strip in shell.css,
  // which lays its children out as a row.
  root.className = "takeover-ask";
  root.setAttribute("role", "alert");

  // No eyebrow: the ember wash, the ember border and role="alert" already say
  // it is urgent, and the heading says the same sentence one line below.
  appendTextChild(root, "h2", "Your bot needs you");
  appendTextChild(
    root,
    "p",
    takeoverReason(handlers.reason),
  );
  appendTextChild(root, "p", "Take control, complete this step, then give control back.");
  appendTextChild(
    root,
    "p",
    "Sign in in the picture on the right — that is your bot's own browser, not Arc or Chrome. The bot does not use your everyday cookies.",
  );

  const acts = appendTextChild(root, "div", "", "acts");
  const take = document.createElement("button");
  take.type = "button";
  take.className = "btn primary";
  take.append(document.createTextNode("Take control "));
  appendTextChild(take, "kbd", modifierKey());
  appendTextChild(take, "kbd", "⇧T");
  take.addEventListener("click", () => handlers.onTake());
  acts.append(take);

  if (handlers.onDecline) {
    const decline = document.createElement("button");
    decline.type = "button";
    decline.className = "btn ghost";
    decline.textContent = "Not needed, continue";
    decline.addEventListener("click", () => handlers.onDecline?.());
    acts.append(decline);
  }

  appendGoogleAccountButton(root, acts, false);

  return {
    root,
    focus: () => take.focus({ preventScroll: true }),
    setBusy: (busy) => {
      take.disabled = busy;
    },
  };
}

export interface PausedHoldHandlers {
  onReturn(): void;
  onTake(): void;
}

/** Expired or timed-out hold: the desktop stays private until control is returned. */
export function renderPausedHold(handlers: PausedHoldHandlers): {
  root: HTMLElement;
  focus(): void;
  setBusy(busy: boolean): void;
} {
  const root = document.createElement("section");
  root.className = "takeover-ask";
  root.setAttribute("role", "status");
  appendTextChild(root, "h2", "Control has paused");
  appendTextChild(
    root,
    "p",
    "Return control once this computer has no private input on screen, or take control to finish.",
  );
  const acts = appendTextChild(root, "div", "", "acts");
  const give = document.createElement("button");
  give.type = "button";
  give.className = "btn primary";
  give.textContent = "Give control back";
  give.addEventListener("click", () => handlers.onReturn());
  const take = document.createElement("button");
  take.type = "button";
  take.className = "btn";
  take.append(document.createTextNode("Take control "));
  appendTextChild(take, "kbd", modifierKey());
  appendTextChild(take, "kbd", "⇧T");
  take.addEventListener("click", () => handlers.onTake());
  acts.append(give, take);
  return {
    root,
    focus: () => give.focus({ preventScroll: true }),
    setBusy: (busy) => {
      give.disabled = busy;
      take.disabled = busy;
    },
  };
}

export interface DrivingHandlers {
  onReturn(): void;
  onStop?: () => void;
  onClear?: () => void;
}

/** Someone else took the keyboard: this window watches and sends nothing. */
export function renderObserving(): { root: HTMLElement } {
  const root = document.createElement("section");
  root.className = "takeover-ask";
  root.setAttribute("role", "status");
  appendTextChild(root, "h2", "Someone else has control");
  appendTextChild(
    root,
    "p",
    "Another window or device is using the computer. This window can’t operate it, but you can still message the bot.",
  );
  return { root };
}

/** Step 2: you have the keyboard. The largest, quietest statement in the app. */
export function renderDriving(handlers: DrivingHandlers): {
  root: HTMLElement;
  focus(): void;
  setBusy(busy: boolean): void;
  setHold(text: string | null): void;
  setLease(msLeft: number | null): void;
} {
  const root = document.createElement("section");
  root.className = "driving";
  root.setAttribute("role", "alert");

  appendTextChild(root, "h2", "You’re driving");
  appendTextChild(
    root,
    "p",
    "Your bot can’t see or operate the computer while you drive. Return control when you are ready.",
  );
  appendTextChild(
    root,
    "p",
    "Typing inside the computer stays out of model context. Messages you send below go to the bot. Sites and apps still receive your input.",
    "q",
  );

  // No live region: this line rewrites itself every second, and a screen
  // reader that read each one out would talk over the page being driven.
  const lease = appendTextChild(root, "p", "", "q");
  lease.hidden = true;

  const hold = appendTextChild(root, "p", "", "q");
  hold.hidden = true;
  hold.setAttribute("role", "status");

  const acts = appendTextChild(root, "div", "", "acts");
  const give = document.createElement("button");
  give.type = "button";
  give.className = "btn primary";
  give.append(document.createTextNode("Give control back "));
  appendTextChild(give, "kbd", modifierKey());
  appendTextChild(give, "kbd", "↩");
  give.addEventListener("click", () => handlers.onReturn());

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "btn";
  clear.textContent = CLEAR_AND_RETURN;
  clear.hidden = true;
  clear.addEventListener("click", () => handlers.onClear?.());

  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "btn ghost";
  stop.textContent = "Stop the task instead";
  if (handlers.onStop) stop.addEventListener("click", () => handlers.onStop?.());
  else stop.hidden = true;

  const google = appendGoogleAccountButton(root, acts, true);

  acts.append(give, clear, stop, google);
  const held = acquiredControl();
  if (held) root.dataset.takeoverId = held;

  const paintHold = (text: string | null): void => {
    hold.textContent = text ?? "";
    hold.hidden = !text;
    const holding = Boolean(text && handlers.onClear);
    clear.hidden = !holding;
    give.className = holding ? "btn" : "btn primary";
    clear.className = holding ? "btn primary" : "btn";
    if (holding) acts.insertBefore(clear, give);
    else acts.insertBefore(give, clear);
  };

  return {
    root,
    focus: () => (clear.hidden ? give : clear).focus({ preventScroll: true }),
    setBusy: (busy) => {
      give.disabled = busy;
      clear.disabled = busy;
      google.disabled = busy;
    },
    setHold: paintHold,
    setLease: (msLeft) => {
      lease.textContent = msLeft === null ? "" : leaseText(msLeft);
      lease.hidden = msLeft === null;
    },
  };
}
