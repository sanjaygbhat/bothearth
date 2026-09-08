/**
 * Atomic vault file I/O with mode 0600.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { VaultFileEnvelope } from "./types.ts";
import {
  VAULT_FORMAT_VERSION,
  VAULT_FORMAT_VERSION_LEGACY,
} from "./types.ts";

export const VAULT_FILE_MODE = 0o600;

/** Assigning these from parsed JSON would mutate the prototype, not set a key. */
const FORBIDDEN_ENVELOPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function asFiniteInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value)) {
    throw new Error(`vault: malformed envelope (${field})`);
  }
  return value;
}

export function parseEnvelope(raw: unknown): VaultFileEnvelope {
  if (!raw || typeof raw !== "object") {
    throw new Error("vault: malformed envelope");
  }
  const o = raw as Record<string, unknown>;
  if (o.v !== VAULT_FORMAT_VERSION && o.v !== VAULT_FORMAT_VERSION_LEGACY) {
    throw new Error(`vault: unsupported format version ${String(o.v)}`);
  }
  if (o.kdf !== "scrypt" && o.kdf !== "raw") {
    throw new Error("vault: malformed envelope");
  }
  if (typeof o.nonce !== "string" || typeof o.ciphertext !== "string") {
    throw new Error("vault: malformed envelope");
  }
  const env: VaultFileEnvelope = {
    v: o.v,
    kdf: o.kdf,
    nonce: o.nonce,
    ciphertext: o.ciphertext,
  };
  if (typeof o.salt === "string") env.salt = o.salt;
  if (o.n !== undefined) env.n = asFiniteInt(o.n, "n");
  if (o.r !== undefined) env.r = asFiniteInt(o.r, "r");
  if (o.p !== undefined) env.p = asFiniteInt(o.p, "p");
  if (env.kdf === "scrypt") {
    if (!env.salt) throw new Error("vault: malformed envelope");
    if (env.v === VAULT_FORMAT_VERSION) {
      if (env.n === undefined || env.r === undefined || env.p === undefined) {
        throw new Error("vault: malformed envelope");
      }
    }
  }
  for (const key of Object.keys(o)) {
    if (FORBIDDEN_ENVELOPE_KEYS.has(key)) {
      throw new Error("vault: malformed envelope");
    }
    if (
      key === "v" ||
      key === "kdf" ||
      key === "n" ||
      key === "r" ||
      key === "p" ||
      key === "salt" ||
      key === "nonce" ||
      key === "ciphertext"
    ) {
      continue;
    }
    (env as unknown as Record<string, unknown>)[key] = o[key];
  }
  return env;
}

export function readEnvelope(path: string): VaultFileEnvelope | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("vault: malformed envelope");
  }
  return parseEnvelope(parsed);
}

/**
 * Write envelope atomically: temp in same dir → fsync → rename → chmod 0600.
 * Original stays readable if the process dies before rename.
 */
export function writeEnvelopeAtomic(
  path: string,
  envelope: VaultFileEnvelope,
): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.vault.${process.pid}.${Date.now()}.tmp`);
  const body = `${JSON.stringify(envelope)}\n`;
  const fd = openSync(tmp, "w", VAULT_FILE_MODE);
  try {
    writeSync(fd, body, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  chmodSync(path, VAULT_FILE_MODE);
}

export function assertMode0600(path: string): void {
  const mode = statSync(path).mode & 0o777;
  if (mode !== VAULT_FILE_MODE) {
    throw new Error(
      `vault: expected mode 0600, got ${mode.toString(8).padStart(3, "0")}`,
    );
  }
}
