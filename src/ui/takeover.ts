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
 *   POST /api/v1/takeover/:id/decline
 *
 * The epoch is never shown or named. Live input is authorised by the server’s
 * mode message, not by this optimistic UI: `LiveView` refuses to relay anything
 * until the server says `human`.
 */

import { apiPost } from "./api.ts";
import { countdownText } from "./needs-you.ts";
import { appendTextChild } from "./safe.ts";

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
    : "Control goes back to the bot as soon as it can take it.";
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
  if (!reason) return "It hit a step it can’t do safely on its own.";
  return REASONS[reason] ?? "It hit a step it can’t do safely on its own.";
}

/** Release can come back still-human when the page is still sensitive. */
export const STILL_SENSITIVE =
  "That page still has a password or a code on it. Finish that step or move off it, then return control again.";

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

/** Returns true when control actually went back to the bot. */
export async function releaseControl(takeoverId: string): Promise<boolean> {
  const response = (await apiPost(
    `/api/v1/takeover/${encodeURIComponent(takeoverId)}/release`,
  )) as { takeover?: { state?: string } };
  return response.takeover?.state !== "human";
}

export async function declineControl(takeoverId: string): Promise<void> {
  await apiPost(`/api/v1/takeover/${encodeURIComponent(takeoverId)}/decline`);
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
    `${takeoverReason(handlers.reason)} Take control, do that one step yourself, then return control and it carries on from there.`
      + (handlers.onDecline ? " If it has that wrong, tell it to carry on without you." : ""),
  );

  const acts = appendTextChild(root, "div", "", "acts");
  const take = document.createElement("button");
  take.type = "button";
  take.className = "btn primary";
  take.append(document.createTextNode("Take control "));
  appendTextChild(take, "kbd", "⌘");
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

  return {
    root,
    focus: () => take.focus({ preventScroll: true }),
    setBusy: (busy) => {
      take.disabled = busy;
    },
  };
}

export interface DrivingHandlers {
  onReturn(): void;
  onStop(): void;
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
    "Another window or device is using its computer. Your bot is paused until control goes back to it, and nothing you type here is sent.",
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
  appendTextChild(give, "kbd", "⌘");
  appendTextChild(give, "kbd", "↩");
  give.addEventListener("click", () => handlers.onReturn());

  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "btn ghost";
  stop.textContent = "Stop the task instead";
  stop.addEventListener("click", () => handlers.onStop());

  acts.append(give, stop);

  return {
    root,
    focus: () => give.focus({ preventScroll: true }),
    setBusy: (busy) => {
      give.disabled = busy;
    },
    setHold: (text) => {
      hold.textContent = text ?? "";
      hold.hidden = !text;
    },
    setLease: (msLeft) => {
      lease.textContent = msLeft === null ? "" : leaseText(msLeft);
      lease.hidden = msLeft === null;
    },
  };
}
