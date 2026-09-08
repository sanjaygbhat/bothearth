/**
 * Thin ModelBot daemon API client for Herdr plugin actions.
 * Bootstraps a UI session with MODELBOT_BOOTSTRAP_TOKEN, then calls /api/v1/*.
 */
export const CSRF_HEADER = "x-csrf-token";
export const SESSION_COOKIE = "modelbot_session";

export function baseUrl() {
  return (
    process.env.MODELBOT_BASE_URL?.replace(/\/$/, "") ||
    process.env.MODELBOT_ENDPOINT?.replace(/\/$/, "") ||
    "http://127.0.0.1:7777"
  );
}

export function bootstrapToken() {
  const t = process.env.MODELBOT_BOOTSTRAP_TOKEN;
  if (!t) {
    throw new Error(
      "MODELBOT_BOOTSTRAP_TOKEN is required (same token used for UI bootstrap)",
    );
  }
  return t;
}

function cookieFromSetCookie(headers) {
  const list =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : headers.get("set-cookie")
        ? [headers.get("set-cookie")]
        : [];
  for (const raw of list) {
    const part = String(raw).split(";")[0];
    if (part && part.startsWith(`${SESSION_COOKIE}=`)) return part;
  }
  return "";
}

/**
 * @returns {Promise<{ base: string, cookie: string, csrf: string, api: (path: string, init?: object) => Promise<any> }>}
 */
export async function openSession() {
  const base = baseUrl();
  const token = bootstrapToken();
  const boot = await fetch(`${base}/api/v1/session/bootstrap`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      origin: base,
    },
    body: JSON.stringify({ token }),
  });
  const bootBody = await boot.json().catch(() => ({}));
  if (!boot.ok) {
    throw new Error(
      `bootstrap failed HTTP ${boot.status}: ${bootBody.message ?? bootBody.error ?? ""}`,
    );
  }
  const cookie = cookieFromSetCookie(boot.headers);
  const csrf = bootBody.csrf;
  if (!cookie || !csrf) {
    throw new Error("bootstrap response missing session cookie or csrf");
  }

  async function api(path, init = {}) {
    const method = (init.method ?? "GET").toUpperCase();
    const mutating = method !== "GET" && method !== "HEAD";
    const headers = {
      accept: "application/json",
      cookie,
      ...(init.headers ?? {}),
    };
    if (mutating) headers[CSRF_HEADER] = csrf;
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body:
        init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!res.ok) {
      const msg =
        json && typeof json === "object"
          ? json.message ?? json.error ?? JSON.stringify(json)
          : String(json);
      const err = new Error(`API ${method} ${path} → HTTP ${res.status}: ${msg}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  return { base, cookie, csrf, api };
}

export function bootstrapUrl(base = baseUrl()) {
  return `${base}/?bootstrap=${encodeURIComponent(bootstrapToken())}`;
}

export function computerIdFromArgs(argv) {
  const flag = argv.indexOf("--computer");
  if (flag >= 0 && argv[flag + 1]) return argv[flag + 1];
  if (process.env.MODELBOT_COMPUTER_ID) return process.env.MODELBOT_COMPUTER_ID;
  const positional = argv.find((a) => !a.startsWith("-"));
  return positional;
}

export async function resolveComputerId(api, argv) {
  const explicit = computerIdFromArgs(argv);
  if (explicit) return explicit;
  const { computers } = await api("/api/v1/computers");
  if (!computers?.length) {
    throw new Error("no computers; create one first (computer-create)");
  }
  return computers[0].id;
}
