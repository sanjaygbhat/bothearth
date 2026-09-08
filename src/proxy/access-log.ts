import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";

const DEFAULT_ACCESS_LOG_PATH = "/tmp/proxy-access.jsonl";
const DEFAULT_ACCESS_LOG_MAX_BYTES = 1_048_576;

export type AccessLine = {
  ts: string;
  host: string;
  port: number;
  allowed: boolean;
  reason: string;
  bytes: number;
  method?: string;
  /** HTTP pathname only — never query/search. */
  path?: string;
};

type AccessLogger = {
  verbose: boolean;
  filePath: string | null;
  maxBytes: number;
  write(line: AccessLine): void;
};

export function isVerboseAccessLog(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.PROXY_ACCESS_LOG_VERBOSE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function accessLogMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PROXY_ACCESS_LOG_MAX_BYTES ?? DEFAULT_ACCESS_LOG_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ACCESS_LOG_MAX_BYTES;
}

export function accessLogFilePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.PROXY_ACCESS_LOG_PATH;
  if (raw === "" || raw === "none" || raw === "stdout") return null;
  return raw ?? DEFAULT_ACCESS_LOG_PATH;
}

/**
 * Default: host:port + decision + bytes. No method, no URL path/query.
 * Verbose (`PROXY_ACCESS_LOG_VERBOSE`): method + HTTP pathname (still no query).
 */
export function formatAccessLine(line: AccessLine, verbose: boolean): string {
  const rec: Record<string, unknown> = {
    ts: line.ts,
    host: line.host,
    port: line.port,
    allowed: line.allowed,
    reason: line.reason,
    bytes: line.bytes,
  };
  if (verbose) {
    if (line.method !== undefined) rec.method = line.method;
    if (line.path !== undefined) rec.path = line.path;
  }
  return JSON.stringify(rec) + "\n";
}

function rotateIfNeeded(path: string, nextBytes: number, maxBytes: number): void {
  if (!existsSync(path)) return;
  const size = statSync(path).size;
  if (size + nextBytes <= maxBytes) return;
  renameSync(path, `${path}.1`);
}

export function appendCapped(path: string, chunk: string, maxBytes: number): void {
  const next = Buffer.byteLength(chunk);
  rotateIfNeeded(path, next, maxBytes);
  appendFileSync(path, chunk);
}

export function createAccessLogger(
  env: NodeJS.ProcessEnv = process.env,
  stdout: { write(s: string): void } = process.stdout,
): AccessLogger {
  const verbose = isVerboseAccessLog(env);
  const filePath = accessLogFilePath(env);
  const maxBytes = accessLogMaxBytes(env);
  return {
    verbose,
    filePath,
    maxBytes,
    write(line: AccessLine): void {
      const text = formatAccessLine(line, verbose);
      stdout.write(text);
      if (!filePath) return;
      try {
        appendCapped(filePath, text, maxBytes);
      } catch {
        // tmpfs/file optional — stdout is the operator-visible sink
      }
    },
  };
}
