import type { DaemonHandle } from "../../src/daemon/server.ts";

export interface DaemonSession {
  /** `name=value`, ready to send as a `cookie` header. */
  cookie: string;
  csrf: string;
  /** Origin, cookie, CSRF token and JSON content type: enough for any mutating call. */
  headers: Record<string, string>;
}

/** Spend a bootstrap token and return the browser session the daemon handed back. */
export async function bootstrapSession(daemon: DaemonHandle, token: string): Promise<DaemonSession> {
  const origin = daemon.baseUrl;
  const res = await fetch(`${origin}/api/v1/session/bootstrap`, {
    method: "POST",
    headers: { origin, host: new URL(origin).host, "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(`bootstrap failed: ${res.status} ${await res.text()}`);
  const { csrf } = (await res.json()) as { csrf: string };
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
  return { cookie, csrf, headers: { origin, cookie, "x-csrf-token": csrf, "content-type": "application/json" } };
}
