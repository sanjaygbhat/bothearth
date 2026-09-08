import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Audit HMAC key source; the vault implements it, tests inject a key. */
export interface AuditKeyProvider {
  getAuditHmacKey(): Buffer | Promise<Buffer>;
}

export function staticAuditKey(key: Buffer | string): AuditKeyProvider {
  const buf = typeof key === "string" ? Buffer.from(key) : key;
  return { getAuditHmacKey: () => buf };
}

export function persistedAuditKey(path: string): AuditKeyProvider {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let key: Buffer;
  try {
    key = readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    key = randomBytes(32);
    try {
      writeFileSync(path, key, { flag: "wx", mode: 0o600 });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
      key = readFileSync(path);
    }
  }
  chmodSync(path, 0o600);
  if (key.length !== 32) throw new Error(`audit HMAC key must be 32 bytes: ${path}`);
  return staticAuditKey(key);
}
