import { apiGet, apiPost, setCsrfToken } from "./api.ts";

export type LicenceInfo = {
  status: "legacy" | "unlicensed" | "active";
  required: boolean;
  label: string;
  account_url?: string;
  covered_release?: string;
  tier?: "noncommercial" | "commercial";
};

export type SessionInfo = {
  ok: boolean;
  csrf: string;
  mode?: "supervised" | "strict";
  spend_cap_usd?: number | null;
  standalone_available?: boolean;
  task_start_available?: boolean;
  model?: string | null;
  execution_mode?: "standalone" | "codex" | "claude" | null;
  budget_kind?: "tool_proxy" | "provider_estimate" | null;
  licence?: LicenceInfo;
  /**
   * What one task may be given: the figure it gets when nobody chooses one, and
   * the most the daemon will accept. Only newer daemons send it; without it the
   * UI names no maximum rather than inventing one.
   */
  budget?: { default_usd?: number | null; max_usd?: number | null } | null;
};

/**
 * Bootstrap URL → HttpOnly session cookie + CSRF.
 * `/#bootstrap=<one-time-token>` exchanged then stripped from the address bar.
 */
let bootstrapExchange: Promise<unknown> = Promise.resolve();

export async function bootstrapSessionFromUrl(returnHash = ""): Promise<SessionInfo | null> {
  const url = new URL(location.href);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const token = fragment.get("bootstrap");
  if (token) {
    fragment.delete("bootstrap");
    url.hash = fragment.toString() || returnHash;
    const cleaned = `${url.pathname}${url.search}${url.hash}`;
    history.replaceState({}, "", cleaned || "/");
    // Strip immediately: a late response must not overwrite a newer route or leave a rejected token in history.
    // Serialize exchanges so overlapping links cannot reorder the session cookie and its CSRF token.
    const exchange = bootstrapExchange.then(async () => {
      const body = (await apiPost("/api/v1/session/bootstrap", { token })) as SessionInfo;
      if (body.csrf) setCsrfToken(body.csrf);
      return body;
    });
    bootstrapExchange = exchange.catch(() => undefined);
    return exchange;
  }
  try {
    const body = (await apiGet("/api/v1/session")) as SessionInfo;
    if (body.csrf) setCsrfToken(body.csrf);
    return body;
  } catch {
    return null;
  }
}

/**
 * One session per page load, shared by everyone who needs it.
 *
 * Several modules want the session as they start: the titlebar chip, home, the
 * task view, the alert loop. They must not each issue their own exchange — the
 * first strips the token from the address bar and the rest then ask an
 * unauthenticated `GET /api/v1/session`, which 401s and makes the app look
 * broken on a perfectly good startup link. They all await this instead.
 */
let inflight: Promise<SessionInfo | null> | null = null;

export function currentSession(returnHash = ""): Promise<SessionInfo | null> {
  inflight ??= bootstrapSessionFromUrl(returnHash);
  return inflight;
}

/** Refresh public settings after a successful mutation; keep this device's identity. */
export function refreshSession(): Promise<SessionInfo | null> {
  inflight = null;
  return currentSession();
}

/**
 * This browser's public device id — the name the daemon puts on a takeover it
 * granted. Comparing it against the holder of a grant is how a page tells "I am
 * driving" from "someone else is". Never the session cookie: the device list
 * hands out a hash of it and so does every event that names an actor.
 */
let deviceInflight: Promise<string | null> | null = null;

export function currentDeviceId(): Promise<string | null> {
  deviceInflight ??= readDeviceId();
  return deviceInflight;
}

async function readDeviceId(): Promise<string | null> {
  try {
    const body = (await apiGet("/api/v1/session/devices")) as {
      devices?: Array<{ id: string; current?: boolean }>;
    };
    return body.devices?.find((device) => device.current)?.id ?? null;
  } catch {
    // Unknown, not "nobody": let the next caller ask again.
    deviceInflight = null;
    return null;
  }
}

/**
 * What a browser can do about a session that is gone. There is no app to
 * reopen — the daemon mints a fresh link from the command line.
 */
export const PAIR_AGAIN =
  "Your sign-in link expired. Run `modelbot pair` in Terminal for a fresh one.";

/** A new startup link replaces the session; the next caller starts a new one. */
export function resetSession(): void {
  inflight = null;
  deviceInflight = null;
}

/**
 * Should this hash change be treated as a new sign-in link, and if so, which
 * route should the app be left on once the link is spent?
 *
 * A startup link can land in a window that is already open — the session
 * expired and the person opened ModelBot again. Exchanging it must not cost
 * them the screen they were reading, and a link that a newer navigation has
 * already superseded must be ignored rather than raced.
 *
 * Returns the hash to return to, or null when this is an ordinary navigation.
 */
export function renewalReturnHash(
  oldURL: string,
  newURL: string,
  currentHref: string,
): string | null {
  let incoming: URL;
  let previous: URL;
  try {
    incoming = new URL(newURL);
    previous = new URL(oldURL);
  } catch {
    return null;
  }
  if (!new URLSearchParams(incoming.hash.replace(/^#/, "")).get("bootstrap")) return null;
  if (newURL !== currentHref) return null; // A newer navigation already won.
  return previous.hash.startsWith("#/") ? previous.hash : "#/";
}
