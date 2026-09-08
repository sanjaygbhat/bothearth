/** UI session API client: cookie auth + CSRF on mutations (DECISIONS R2 / ARCH §6). */

export const CSRF_HEADER = "X-CSRF-Token";

let csrfToken = "";

export function getCsrfToken(): string {
  return csrfToken;
}

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

/**
 * How far this browser's clock is from the daemon's, in milliseconds.
 *
 * The approval countdown compares a server timestamp with the browser's own.
 * A phone whose clock is out by a couple of minutes would show a card that had
 * already expired, or one that stayed live past the real expiry. The payload's
 * timestamps are redundant, so skew can only be read from the `Date` header of
 * a response, taken at receipt.
 */
let clockOffsetMs = 0;

/** `Date.now()` corrected onto the daemon's clock. */
export function serverNow(): number {
  return Date.now() + clockOffsetMs;
}

function noteServerClock(res: Response): void {
  const header = res.headers.get("Date");
  if (!header) return;
  const server = Date.parse(header);
  if (!Number.isFinite(server)) return;
  // The header has one-second resolution and the round trip is unknown, so a
  // difference under two seconds is noise and is deliberately ignored — the
  // offset exists to survive a wrong clock, not to chase network latency.
  const offset = server - Date.now();
  clockOffsetMs = Math.abs(offset) < 2000 ? 0 : offset;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text.length) return null;
  // An empty body is a body, not a broken one: a `HEAD`, a 204, or a 404 whose
  // whole answer is its status code. Parsing it as JSON would throw a
  // SyntaxError over the HTTP status the caller needs.
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("application/json") ? (JSON.parse(text) as unknown) : text;
}

export async function apiFetch(
  path: string,
  init: RequestInit & { csrf?: boolean } = {},
): Promise<unknown> {
  const headers = new Headers(init.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  const method = (init.method ?? "GET").toUpperCase();
  const mutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  if (mutating || init.csrf) {
    if (csrfToken) headers.set(CSRF_HEADER, csrfToken);
  }
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  noteServerClock(res);
  const body = await parseBody(res);
  if (!res.ok) {
    const msg =
      typeof body === "object" &&
      body !== null &&
      "message" in body && typeof (body as { message: unknown }).message === "string"
        ? (body as { message: string }).message
        : typeof body === "object" && body !== null && "error" in body &&
      typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `HTTP ${res.status}`;
    throw new ApiError(res.status, msg, body);
  }
  return body;
}

/**
 * A message fit to put on screen.
 *
 * The daemon writes two kinds of error text: real sentences meant for a person
 * ("Your current task is still working. Open it to continue…") and short
 * internal codes ("missing session", "E_SANDBOX"). A server message is used
 * only when it reads as a sentence; anything else falls back to the caller's
 * own copy.
 */
export function humanApiError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message.trim() : "";
  if (!raw) return fallback;
  const looksWritten =
    raw.length > 24 &&
    raw.includes(" ") &&
    /^[A-Z“"']/.test(raw) &&
    /[.!?”"']$/.test(raw) &&
    !/^[A-Z_]+$/.test(raw) &&
    !/\bE_[A-Z_]+\b/.test(raw);
  return looksWritten ? raw : fallback;
}

export function apiGet(path: string): Promise<unknown> {
  return apiFetch(path);
}

export function apiPost(path: string, body?: unknown): Promise<unknown> {
  return apiFetch(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function apiDelete(path: string): Promise<unknown> {
  return apiFetch(path, { method: "DELETE" });
}
