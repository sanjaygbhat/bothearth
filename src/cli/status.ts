/**
 * `modelbot status` / `modelbot status --watch` — refresh every 2s.
 */
import { SESSION_COOKIE } from "../daemon/auth.ts";

interface StatusSnapshot {
  computers: unknown[];
  tasks: unknown[];
  takeovers: unknown[];
  approvals: unknown[];
  baseUrl: string;
  at: string;
}

function baseUrlFromEnv(): string {
  return (
    process.env.MODELBOT_BASE_URL?.replace(/\/$/, "") ||
    process.env.MODELBOT_ENDPOINT?.replace(/\/$/, "") ||
    "http://127.0.0.1:7777"
  );
}

function cookieFromSetCookie(headers: Headers): string {
  for (const raw of headers.getSetCookie()) {
    const part = String(raw).split(";")[0];
    if (part?.startsWith(`${SESSION_COOKIE}=`)) return part;
  }
  return "";
}

async function openUiSession(base: string): Promise<{
  cookie: string;
  csrf: string;
}> {
  const token = process.env.MODELBOT_BOOTSTRAP_TOKEN;
  if (!token) {
    throw new Error(
      "MODELBOT_BOOTSTRAP_TOKEN required for modelbot status (UI session bootstrap)",
    );
  }
  const res = await fetch(`${base}/api/v1/session/bootstrap`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      // Bootstrap requires a same-origin Origin (CSRF); CLI uses the daemon base.
      origin: base,
    },
    body: JSON.stringify({ token }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    csrf?: string;
    error?: string;
    message?: string;
  };
  if (!res.ok) {
    throw new Error(
      `bootstrap failed HTTP ${res.status}: ${body.message ?? body.error ?? ""}`,
    );
  }
  const cookie = cookieFromSetCookie(res.headers);
  if (!cookie || !body.csrf) {
    throw new Error("bootstrap missing session cookie or csrf");
  }
  return { cookie, csrf: body.csrf };
}

async function apiGet(
  base: string,
  cookie: string,
  path: string,
): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    headers: { accept: "application/json", cookie },
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  if (!res.ok) {
    throw new Error(`GET ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return json;
}

export async function fetchStatusSnapshot(
  base = baseUrlFromEnv(),
): Promise<StatusSnapshot> {
  const health = await fetch(`${base}/healthz`).catch(() => null);
  if (!health || !health.ok) {
    throw new Error(`daemon not reachable at ${base}/healthz`);
  }
  const { cookie } = await openUiSession(base);
  const [computers, tasks, takeovers, approvals] = await Promise.all([
    apiGet(base, cookie, "/api/v1/computers"),
    apiGet(base, cookie, "/api/v1/tasks"),
    apiGet(base, cookie, "/api/v1/takeovers").catch(() => ({ takeovers: [] })),
    apiGet(base, cookie, "/api/v1/approvals"),
  ]);
  const c = computers as { computers?: unknown[] };
  const t = tasks as { tasks?: unknown[] };
  const tk = takeovers as { takeovers?: unknown[] };
  const a = approvals as { approvals?: unknown[] };
  return {
    computers: c.computers ?? [],
    tasks: t.tasks ?? [],
    takeovers: tk.takeovers ?? [],
    approvals: a.approvals ?? [],
    baseUrl: base,
    at: new Date().toISOString(),
  };
}

function formatSnapshot(s: StatusSnapshot): string {
  const lines: string[] = [];
  lines.push(`modelbot status  ${s.at}  ${s.baseUrl}`);
  lines.push("");
  lines.push(`computers (${s.computers.length})`);
  for (const raw of s.computers) {
    const c = raw as {
      id?: string;
      name?: string;
      status?: string;
    };
    lines.push(`  ${c.id ?? "?"}  ${c.status ?? "?"}  ${c.name ?? ""}`);
  }
  lines.push(`tasks (${s.tasks.length})`);
  for (const raw of s.tasks) {
    const t = raw as {
      id?: string;
      status?: string;
      goal?: string;
      computer_id?: string;
    };
    const goal = (t.goal ?? "").slice(0, 60);
    lines.push(
      `  ${t.id ?? "?"}  ${t.status ?? "?"}  computer=${t.computer_id ?? "?"}  ${goal}`,
    );
  }
  lines.push(`takeovers (${s.takeovers.length})`);
  for (const raw of s.takeovers) {
    const t = raw as {
      id?: string;
      state?: string;
      computer_id?: string;
    };
    lines.push(
      `  ${t.id ?? "?"}  ${t.state ?? "?"}  computer=${t.computer_id ?? "?"}`,
    );
  }
  lines.push(`approvals (${s.approvals.length})`);
  for (const raw of s.approvals) {
    const a = raw as {
      id?: string;
      status?: string;
      tool?: string;
    };
    lines.push(`  ${a.id ?? "?"}  ${a.status ?? "?"}  ${a.tool ?? ""}`);
  }
  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runStatus(argv: string[]): Promise<void> {
  const watch = argv.includes("--watch");
  const json = argv.includes("--json");
  const base = baseUrlFromEnv();

  const once = async () => {
    const snap = await fetchStatusSnapshot(base);
    if (json) {
      console.log(JSON.stringify(snap, null, 2));
    } else {
      if (watch && process.stdout.isTTY) {
        process.stdout.write("\x1b[2J\x1b[H");
      }
      console.log(formatSnapshot(snap));
    }
  };

  if (!watch) {
    await once();
    return;
  }

  for (;;) {
    try {
      await once();
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
    }
    await sleep(2000);
  }
}
