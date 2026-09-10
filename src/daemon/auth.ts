import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "modelbot_session";
export const CSRF_HEADER = "x-csrf-token";

/**
 * Idle window. Any authenticated request slides it forward from now. A browser
 * left alone overnight, or over a weekend, must still open: an 8-hour window
 * sent the owner back to `modelbot pair` after a day away.
 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Ceiling measured from the pairing: sliding cannot keep a session alive forever. */
export const SESSION_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

export function mintToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/**
 * Max-Age, not a browser-session cookie: quitting the browser used to throw the
 * session away and force a fresh `modelbot pair`. The server still decides when
 * the session dies; the cookie only has to outlive the browser.
 */
export function sessionCookieHeader(sessionId: string, secure = false, name = SESSION_COOKIE): string {
  const maxAge = Math.floor(SESSION_MAX_LIFETIME_MS / 1000);
  return `${name}=${encodeURIComponent(sessionId)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function clearSessionCookieHeader(secure = false, name = SESSION_COOKIE): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}

function safeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m ? m[1]!.trim() : null;
}

function isLoopbackOrigin(origin: string, port: number): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]" && host !== "::1") {
      return false;
    }
    const p = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    return p === port;
  } catch {
    return false;
  }
}

export function checkHost(
  hostHeader: string | undefined,
  port: number,
  allowedHosts: string[] = [],
): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.trim().toLowerCase();
  const ok = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    ...allowedHosts.map((h) => h.toLowerCase()),
  ]);
  return ok.has(host);
}

/** Present Origin must match loopback UI; missing Origin OK (non-browser). */
export function checkApiOrigin(
  origin: string | undefined,
  port: number,
  allowedHosts: string[] = [],
): "ok" | "bad" {
  if (!origin) return "ok";
  if (isLoopbackOrigin(origin, port)) return "ok";
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:") return "bad";
    const allowed = new Set(allowedHosts.map((host) => host.toLowerCase()));
    return allowed.has(parsed.host.toLowerCase()) || allowed.has(parsed.hostname.toLowerCase())
      ? "ok"
      : "bad";
  } catch {
    return "bad";
  }
}

/** /mcp: reject browser Origins (MCP clients send none). */
export function checkMcpOrigin(origin: string | undefined): "ok" | "bad" {
  if (!origin) return "ok";
  return "bad";
}

export function isMcpToken(
  authHeader: string | undefined,
  mcpToken: string,
): boolean {
  const bearer = extractBearer(authHeader);
  if (!bearer || !mcpToken) return false;
  return safeEqualStr(bearer, mcpToken);
}

export function wsAcceptKey(secWebSocketKey: string): string {
  return createHash("sha1")
    .update(secWebSocketKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
}

/** Explicit trusted proxy origin, never inferred from forwarded headers. */
export function canonicalHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("remote public_origin must be a bare HTTPS origin");
  }
  return url.origin;
}

/** Non-bearer public identifier; never expose the session cookie in device lists. */
export function deviceId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}
