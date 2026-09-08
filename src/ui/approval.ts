/**
 * Approval — "your bot needs you".
 *
 * The card may shrink, its body is the only thing that scrolls, and the action
 * row sits outside that scroller, so no window size can clip an action. The
 * gate is translated into a plain sentence; the literal payload stays behind
 * "Show exactly what it will do" and is not in the DOM until opened.
 *
 * Expiry never approves. It pauses and waits: the daemon marks the approval
 * expired and the tool call stays blocked.
 */

import { apiPost, serverNow } from "./api.ts";
import { appendTextChild } from "./safe.ts";
import { icon } from "./live/icons.ts";
import type {
  ApprovalBind,
  ApprovalDecision,
  PolicyGate,
} from "../types/contracts.ts";

export interface PendingApproval {
  approval_id: string;
  tool: string;
  gate: PolicyGate | string;
  args: Record<string, unknown>;
  bind: ApprovalBind & { navigation_url?: string };
  created_at: string;
  /** When the lease runs out. Preferred over `bind.expires`. */
  expires_at?: string | null;
  /** The daemon offers a remembered grant. The third button is drawn only then. */
  can_remember?: boolean;
}

/**
 * Where the thing is going. Decided once from the payload and then used in the
 * heading, the body and the destination row, so one card names one place.
 *
 *   site     out to the internet, to a named host
 *   sandbox  stays inside its computer
 *   mac      leaves its computer for your Mac
 */
export type DestinationKind = "site" | "sandbox" | "mac";

export interface ApprovalCopy {
  kind: DestinationKind;
  /** The ONE noun this card uses for the destination, everywhere. */
  place: string;
  title: string;
  what: string;
  destName: string;
  destNote: string;
  destIcon: "file" | "globe" | "laptop";
  discloseLabel: string;
  /** Label for the remembered grant, or null when it is not on offer. */
  rememberLabel: string | null;
}

/*
 * `new_domain` is deliberately absent. All that gate knows is that THIS task
 * has not been allowed this site yet — nothing about whether the bot has been
 * there before, and the browser profile it drives is routinely already signed
 * in. The sentence for it is built below, and says only what the grant covers.
 */
const GATE_WHY: Record<string, string> = {
  external_send:
    "This is the first time it has sent anything out of its computer.",
  payment: "This one spends money, so it will not do it without you.",
  upload: "This sends a file off its computer.",
  delete: "This deletes something, and deleting cannot be undone.",
  secret_entry:
    "This needs a password or a code, and your bot never handles those on its own.",
};

const TOOL_VERB: Record<string, string> = {
  browser_navigate: "open a site",
  browser_tabs: "open a site",
  browser_click: "press something on the page",
  browser_type: "type into the page",
  files_write: "write a file on its computer",
  files_read: "read a file on its computer",
  shell_exec: "run a command on its computer",
  connector_call: "send this to an app you use",
};

function stringField(args: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (value && typeof value === "object") {
      const nested = stringField(value as Record<string, unknown>, ...names);
      if (nested) return nested;
    }
  }
  return null;
}

/** Bare host, or null when the destination never leaves this Mac. */
export function destinationHost(req: PendingApproval): string | null {
  const raw =
    req.bind.navigation_url ??
    stringField(req.args, "url", "href", "endpoint") ??
    req.bind.origin;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return null;
    return url.host;
  } catch {
    return null;
  }
}

/**
 * Which of the three destinations this ask is about. The gate decides, not the
 * tool: `external_send` is by definition something leaving its computer, and
 * everything else a file tool does stays inside it.
 */
export function destinationKind(req: PendingApproval): DestinationKind {
  if (destinationHost(req)) return "site";
  return req.gate === "external_send" ? "mac" : "sandbox";
}

export function describeApproval(req: PendingApproval): ApprovalCopy {
  const host = destinationHost(req);
  const kind = destinationKind(req);
  // ONE noun, chosen here, used in every sentence below. Nothing downstream is
  // allowed to invent a second name for the same place.
  const place = kind === "site" ? (host as string) : kind === "mac" ? "your Mac" : "its computer";

  const why = GATE_WHY[String(req.gate)] ?? "Your bot wants your OK before it goes on.";
  const raw = stringField(req.args, "path", "name", "title", "filename");
  const name = raw ? (raw.split(/[\\/]/).filter(Boolean).pop() ?? raw) : null;

  // The verb has to agree with the destination. "Write a file on its computer"
  // beside "the first time it has sent anything out of its computer" reads as a
  // contradiction, so the destination wins over the tool's own phrasing.
  const verb =
    kind === "site"
      ? req.tool === "browser_navigate" || req.tool === "browser_tabs"
        ? `open ${place}`
        : `send this to ${place}`
      : kind === "mac"
        ? `put this on ${place}, where you can open it`
        : (TOOL_VERB[req.tool] ?? "do one thing it cannot do on its own");

  let title: string;
  if (kind === "site") {
    title =
      req.tool === "browser_navigate" || req.tool === "browser_tabs"
        ? `Open ${place}?`
        : `Send this to ${place}?`;
  } else if (kind === "mac") {
    title = name && name.length <= 24 ? `Put “${name}” on ${place}?` : `Put a file on ${place}?`;
  } else if (req.tool === "files_write") {
    // The heading stays a short question. A long file name belongs on the
    // destination row, where it can wrap without shouting.
    title = name && name.length <= 24 ? `Save “${name}” on ${place}?` : `Save a file on ${place}?`;
  } else if (req.tool === "shell_exec") {
    title = `Run a command on ${place}?`;
  } else {
    title = "Let your bot go ahead?";
  }

  // A site ask is scoped to this one task, and that is the whole of what it
  // claims. It used to add "This is the first time your bot has opened this
  // site", which a person looking at their own signed-in Gmail knew to be
  // false — and a card that lies about the small thing is not believed about
  // the large one.
  const what =
    req.gate === "new_domain"
      ? `Your bot wants to ${verb} for this task.`
      : `Your bot wants to ${verb}. ${why}`;

  return {
    kind,
    place,
    title,
    what,
    destName: host ?? name ?? "Its computer",
    destNote:
      kind === "site"
        ? `Leaves its computer for ${place}`
        : kind === "mac"
          ? "Leaves its computer for your Mac"
          : "Stays on its computer · nothing leaves this Mac",
    destIcon: kind === "site" ? "globe" : req.tool.startsWith("files_") ? "file" : "laptop",
    discloseLabel:
      req.tool === "files_write"
        ? "Show exactly what it will write"
        : kind === "site"
          ? "Show exactly what it will send"
          : "Show exactly what it will do",
    // The grant is scoped to this one task, and the label says exactly that —
    // never "Always", which would promise a rule the grant does not keep. The
    // host is left out: it is already the heading and the destination row.
    rememberLabel:
      req.can_remember && kind === "site" ? "Allow this site for the task" : null,
  };
}

/**
 * The literal payload, with anything that looks like a credential replaced.
 * A person needs to see what will happen; nobody needs a password on screen.
 */
export function sanitizePayload(args: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (Array.isArray(args)) return args.slice(0, 50).map((v) => sanitizePayload(v, depth + 1));
  if (args && typeof args === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
      out[key] = /pass|secret|token|cookie|authorization|api[_-]?key|otp|credential/i.test(key)
        ? "••••••"
        : sanitizePayload(value, depth + 1);
    }
    return out;
  }
  if (typeof args === "string" && args.length > 4000) return `${args.slice(0, 4000)}…`;
  return args;
}

/**
 * When the daemon's lease runs out, in epoch ms, or null when the record does
 * not say. The COUNTDOWN is the attention banner's (needs-you.ts), which reads
 * the same deadline; a second one on the card only ever disagreed with it.
 */
export function approvalDeadline(req: PendingApproval): number | null {
  const declared = Date.parse(req.expires_at ?? req.bind.expires ?? "");
  return Number.isFinite(declared) ? declared : null;
}

/*
 * The decisions are exactly the ones the daemon defines (`ApprovalDecision` in
 * contracts.ts); the UI adds no fourth. `allow_task` is `allow_once` plus an
 * origin grant that lasts this task and no longer.
 */

export async function decideApproval(
  approvalId: string,
  decision: ApprovalDecision,
  bind: ApprovalBind,
): Promise<void> {
  await apiPost(`/api/v1/approvals/${encodeURIComponent(approvalId)}`, {
    decision,
    bind,
  });
}

export interface ApprovalHandlers {
  onDecide(decision: ApprovalDecision): void;
  onExpire?(): void;
  /** ms remaining, for tests; defaults to the wall clock. */
  now?: () => number;
}

export interface ApprovalSurface {
  root: HTMLElement;
  focus(): void;
  /** Esc = don’t allow, Enter = allow once. Returns true if handled. */
  handleKey(event: KeyboardEvent): boolean;
  setBusy(busy: boolean): void;
  destroy(): void;
}

let approvalSeq = 0;

export function renderApproval(
  req: PendingApproval,
  handlers: ApprovalHandlers,
): ApprovalSurface {
  const copy = describeApproval(req);
  // Read off the daemon's clock, not the browser's.
  const now = handlers.now ?? serverNow;
  const seq = ++approvalSeq;
  const headingId = `apv-h-${seq}`;
  const bodyId = `apv-b-${seq}`;

  const root = document.createElement("section");
  root.className = "approval";
  // Assertive by nature: it blocks the task, so it is not aria-live=polite.
  root.setAttribute("role", "alertdialog");
  root.setAttribute("aria-labelledby", headingId);
  root.setAttribute("aria-describedby", bodyId);
  root.dataset.approvalId = req.approval_id;

  const body = appendTextChild(root, "div", "", "approval-body");

  const eyebrow = appendTextChild(body, "div", "", "eyebrow");
  appendTextChild(eyebrow, "span", "", "dot run");
  appendTextChild(eyebrow, "span", "Your bot needs you", "caps");

  const heading = appendTextChild(body, "h2", copy.title);
  heading.id = headingId;

  const what = appendTextChild(body, "p", copy.what, "what-why");
  what.id = bodyId;

  const dest = appendTextChild(body, "div", "", "dest");
  const glyph = appendTextChild(dest, "span", "", "g");
  glyph.append(icon(copy.destIcon));
  const destText = appendTextChild(dest, "span", "");
  appendTextChild(destText, "span", copy.destName, "n");
  appendTextChild(destText, "span", copy.destNote, "w");

  const disclose = document.createElement("button");
  disclose.type = "button";
  disclose.className = "disclose";
  disclose.setAttribute("aria-expanded", "false");
  appendTextChild(disclose, "span", "▶", "cv");
  disclose.append(document.createTextNode(copy.discloseLabel));
  body.append(disclose);

  // The payload is NOT in the DOM until it is asked for.
  let payload: HTMLElement | null = null;
  disclose.addEventListener("click", () => {
    if (payload) {
      payload.remove();
      payload = null;
      disclose.setAttribute("aria-expanded", "false");
      return;
    }
    payload = appendTextChild(
      body,
      "pre",
      JSON.stringify(sanitizePayload(req.args), null, 2),
      "payload",
    );
    payload.tabIndex = 0;
    disclose.setAttribute("aria-expanded", "true");
  });

  const actions = appendTextChild(root, "div", "", "approval-actions");
  const row = appendTextChild(actions, "span", "", "btnrow");

  // Refusing is not destructive; it is the safe answer. Neutral ink, and the
  // ember stays on the one button that acts — warm danger beside a warm ember
  // primary is the pairing the colour-blindness note forbids.
  const deny = document.createElement("button");
  deny.type = "button";
  deny.className = "btn";
  deny.append(document.createTextNode("Don’t allow "));
  appendTextChild(deny, "kbd", "esc");

  // Built either way so the handlers below have one shape, but only ever put in
  // the DOM when the daemon offered the grant — a hidden button is still a tab
  // stop and still reads to a screen reader in some engines.
  const remember = document.createElement("button");
  remember.type = "button";
  remember.className = "btn";
  if (copy.rememberLabel) remember.textContent = copy.rememberLabel;

  const allow = document.createElement("button");
  allow.type = "button";
  allow.className = "btn primary";
  allow.append(document.createTextNode("Allow once "));
  appendTextChild(allow, "kbd", "↩");

  if (copy.rememberLabel) row.append(deny, remember, allow);
  else row.append(deny, allow);

  let expired = false;
  const decide = (decision: ApprovalDecision): void => {
    if (expired) return;
    handlers.onDecide(decision);
  };
  deny.addEventListener("click", () => decide("deny"));
  remember.addEventListener("click", () => decide("allow_task"));
  allow.addEventListener("click", () => decide("allow_once"));

  // Measured against the daemon’s own clock (`serverNow`), so a browser a few
  // minutes out neither disables a live ask nor keeps a dead one answerable.
  const deadline = approvalDeadline(req);

  const expire = (): void => {
    if (expired) return;
    expired = true;
    deny.disabled = true;
    remember.disabled = true;
    allow.disabled = true;
    window.clearInterval(handle);
    handlers.onExpire?.();
  };
  let handle = 0;
  if (deadline !== null) {
    if (deadline <= now()) expire();
    else handle = window.setInterval(() => { if (deadline <= now()) expire(); }, 500);
  }

  return {
    root,
    focus() {
      allow.focus({ preventScroll: true });
    },
    handleKey(event) {
      if (expired) return false;
      if (event.key === "Escape") {
        event.preventDefault();
        decide("deny");
        return true;
      }
      if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
        // The focused button activates itself on Enter; do not double-fire.
        const tag = (event.target as { tagName?: string } | null)?.tagName;
        if (tag && tag.toLowerCase() === "button") return false;
        event.preventDefault();
        decide("allow_once");
        return true;
      }
      return false;
    },
    setBusy(busy) {
      deny.disabled = busy || expired;
      remember.disabled = busy || expired;
      allow.disabled = busy || expired;
    },
    destroy() {
      window.clearInterval(handle);
      root.remove();
    },
  };
}
