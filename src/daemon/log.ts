type LogFields = Record<string, unknown>;

const SECRET_KEYS = new Set([
  "token",
  "mcp_token",
  "bootstrap",
  "bootstrap_token",
  "authorization",
  "cookie",
  "csrf",
  "password",
  "api_key",
  "secret",
]);

const STRIP_SUFFIXES = ["_preview", "_excerpt", "_snippet", "_sample", "_truncated"] as const;

const VALUE_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]+\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];

function normalizeLogKey(key: string): string {
  let s = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/-/g, "_");
  s = s.replace(/_+/g, "_");
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const suffix of STRIP_SUFFIXES) {
      if (s.endsWith(suffix)) {
        s = s.slice(0, -suffix.length);
        stripped = true;
      }
    }
  }
  return s;
}

export function redactStringValue(value: string): string {
  let out = value;
  for (const pattern of VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}

function redact(value: unknown, key?: string): unknown {
  if (key && SECRET_KEYS.has(normalizeLogKey(key))) return "[redacted]";
  if (typeof value === "string") return redactStringValue(value);
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, k);
    }
    return out;
  }
  return value;
}

export function redactLogFields(fields: LogFields): unknown {
  return redact(fields);
}

export function logInfo(msg: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ level: "info", msg, ...redact(fields) as object, ts: new Date().toISOString() }));
}

export function logWarn(msg: string, fields: LogFields = {}): void {
  console.warn(JSON.stringify({ level: "warn", msg, ...redact(fields) as object, ts: new Date().toISOString() }));
}

export function logError(msg: string, fields: LogFields = {}): void {
  console.error(JSON.stringify({ level: "error", msg, ...redact(fields) as object, ts: new Date().toISOString() }));
}
