import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

type LogFields = Record<string, unknown>;

/** Rotate `daemon.log` to `daemon.log.1` once the live file exceeds this size. */
export const DAEMON_LOG_MAX_BYTES = 20 * 1024 * 1024;

let fileLogPath: string | undefined;

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

export function daemonLogPath(dataDir: string): string {
  return join(dataDir, "logs", "daemon.log");
}

/**
 * Append structured log lines to `<dataDir>/logs/daemon.log` in addition to
 * stdout. Foreground `start` and `start --daemon` both go through here.
 */
export function attachDaemonFileLog(dataDir: string): string {
  const path = daemonLogPath(dataDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
  chmodSync(path, 0o600);
  fileLogPath = path;
  return path;
}

/** Tests only. */
export function detachDaemonFileLog(): void {
  fileLogPath = undefined;
}

function rotateIfNeeded(path: string): void {
  if (!existsSync(path)) return;
  try {
    if (statSync(path).size <= DAEMON_LOG_MAX_BYTES) return;
    const rotated = `${path}.1`;
    if (existsSync(rotated)) unlinkSync(rotated);
    renameSync(path, rotated);
    chmodSync(rotated, 0o600);
  } catch {
    /* stdout still works */
  }
}

function appendFileLog(line: string): void {
  if (!fileLogPath) return;
  try {
    rotateIfNeeded(fileLogPath);
    appendFileSync(fileLogPath, `${line}\n`, { mode: 0o600 });
    chmodSync(fileLogPath, 0o600);
  } catch {
    /* stdout still works */
  }
}

function emit(
  level: "info" | "warn" | "error",
  write: (line: string) => void,
  msg: string,
  fields: LogFields,
): void {
  const line = JSON.stringify({
    level,
    msg,
    ...(redact(fields) as object),
    ts: new Date().toISOString(),
  });
  write(line);
  appendFileLog(line);
}

export function logInfo(msg: string, fields: LogFields = {}): void {
  emit("info", console.log, msg, fields);
}

export function logWarn(msg: string, fields: LogFields = {}): void {
  emit("warn", console.warn, msg, fields);
}

export function logError(msg: string, fields: LogFields = {}): void {
  emit("error", console.error, msg, fields);
}
