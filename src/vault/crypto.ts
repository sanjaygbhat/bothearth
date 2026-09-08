/**
 * Vault crypto: AES-256-GCM + scrypt (node:crypto only).
 * v=2 binds the full envelope header (everything except ciphertext) as GCM AAD.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { ScryptParams, VaultFileEnvelope, VaultPayload } from "./types.ts";
import {
  VAULT_FORMAT_VERSION,
  VAULT_FORMAT_VERSION_LEGACY,
} from "./types.ts";

export const SCRYPT_N_LEGACY = 16384;
export const SCRYPT_N_CURRENT = 131072; // 2^17; memory ≈128 MiB with r=8
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const AES_KEY_LEN = 32;

export const SCRYPT_PARAMS_LEGACY: ScryptParams = {
  n: SCRYPT_N_LEGACY,
  r: SCRYPT_R,
  p: SCRYPT_P,
};
export const SCRYPT_PARAMS_CURRENT: ScryptParams = {
  n: SCRYPT_N_CURRENT,
  r: SCRYPT_R,
  p: SCRYPT_P,
};

function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function assertScryptParams(params: ScryptParams): void {
  const { n, r, p } = params;
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    throw new Error("vault: invalid kdf params");
  }
  if (!isPow2(n) || n < SCRYPT_N_LEGACY || n > SCRYPT_N_CURRENT) {
    throw new Error("vault: invalid kdf params");
  }
  if (r !== SCRYPT_R || p !== SCRYPT_P) {
    throw new Error("vault: invalid kdf params");
  }
}

function scryptMaxmem(params: ScryptParams): number {
  // Node requires maxmem >= 128 * N * r * p; add slack for allocator overhead.
  return 128 * params.n * params.r * params.p + 16 * 1024 * 1024;
}

export function deriveScryptKey(
  passphrase: string,
  salt: Buffer,
  params: ScryptParams = SCRYPT_PARAMS_CURRENT,
): Buffer {
  assertScryptParams(params);
  return scryptSync(passphrase, salt, SCRYPT_KEYLEN, {
    N: params.n,
    r: params.r,
    p: params.p,
    maxmem: scryptMaxmem(params),
  });
}

export function randomMasterKey(): Buffer {
  return randomBytes(AES_KEY_LEN);
}

export function randomSalt(): Buffer {
  return randomBytes(SALT_LEN);
}

export function randomNonce(): Buffer {
  return randomBytes(NONCE_LEN);
}

function assertKeyLen(key: Buffer): void {
  if (key.length !== AES_KEY_LEN) {
    throw new Error(`vault: AES key must be ${AES_KEY_LEN} bytes`);
  }
}

/**
 * Canonical JSON of every envelope field except ciphertext (sorted keys).
 * Bound as AES-GCM AAD on v=2 writes.
 */
export function serializeEnvelopeHeader(envelope: VaultFileEnvelope): Buffer {
  const src = envelope as unknown as Record<string, unknown>;
  const header: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    if (key === "ciphertext") continue;
    header[key] = src[key];
  }
  return Buffer.from(JSON.stringify(header), "utf8");
}

export function scryptParamsFromEnvelope(
  envelope: VaultFileEnvelope,
): ScryptParams {
  if (envelope.v === VAULT_FORMAT_VERSION_LEGACY) {
    return SCRYPT_PARAMS_LEGACY;
  }
  if (
    envelope.n === undefined ||
    envelope.r === undefined ||
    envelope.p === undefined
  ) {
    throw new Error("vault: missing kdf params");
  }
  const params = { n: envelope.n, r: envelope.r, p: envelope.p };
  assertScryptParams(params);
  return params;
}

export function envelopeNeedsReWrap(envelope: VaultFileEnvelope): boolean {
  if (envelope.v !== VAULT_FORMAT_VERSION) return true;
  if (envelope.kdf === "scrypt") {
    return (
      envelope.n !== SCRYPT_N_CURRENT ||
      envelope.r !== SCRYPT_R ||
      envelope.p !== SCRYPT_P
    );
  }
  return false;
}

export function encryptPayload(
  key: Buffer,
  payload: VaultPayload,
  meta: { kdf: "scrypt" | "raw"; salt?: Buffer; params?: ScryptParams },
): VaultFileEnvelope {
  assertKeyLen(key);
  const nonce = randomNonce();
  const env: VaultFileEnvelope = {
    v: VAULT_FORMAT_VERSION,
    kdf: meta.kdf,
    nonce: nonce.toString("base64"),
    ciphertext: "",
  };
  if (meta.kdf === "scrypt") {
    if (!meta.salt || meta.salt.length < SALT_LEN) {
      throw new Error("vault: scrypt requires salt");
    }
    const params = meta.params ?? SCRYPT_PARAMS_CURRENT;
    assertScryptParams(params);
    env.n = params.n;
    env.r = params.r;
    env.p = params.p;
    env.salt = meta.salt.toString("base64");
  }
  const plain = Buffer.from(JSON.stringify(payload), "utf8");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(serializeEnvelopeHeader(env));
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  env.ciphertext = Buffer.concat([enc, tag]).toString("base64");
  return env;
}

export function decryptPayload(
  key: Buffer,
  envelope: VaultFileEnvelope,
): VaultPayload {
  assertKeyLen(key);
  if (
    envelope.v !== VAULT_FORMAT_VERSION &&
    envelope.v !== VAULT_FORMAT_VERSION_LEGACY
  ) {
    throw new Error(`vault: unsupported format version ${String(envelope.v)}`);
  }
  const nonce = Buffer.from(envelope.nonce, "base64");
  if (nonce.length !== NONCE_LEN) {
    throw new Error("vault: invalid nonce");
  }
  const blob = Buffer.from(envelope.ciphertext, "base64");
  if (blob.length <= TAG_LEN) {
    throw new Error("vault: invalid ciphertext");
  }
  const tag = blob.subarray(blob.length - TAG_LEN);
  const data = blob.subarray(0, blob.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  if (envelope.v === VAULT_FORMAT_VERSION) {
    decipher.setAAD(serializeEnvelopeHeader(envelope));
  }
  decipher.setAuthTag(tag);
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new Error("vault: decryption failed (wrong key or corrupt file)");
  }
  const parsed = JSON.parse(plain.toString("utf8")) as VaultPayload;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.entries !== "object"
  ) {
    throw new Error("vault: corrupt payload");
  }
  return parsed;
}

/** Resolve AES key from envelope + key material (passphrase or raw). */
export function resolveFileKey(
  envelope: VaultFileEnvelope,
  material: { key: Buffer; passphrase?: string },
): Buffer {
  if (envelope.kdf === "raw") {
    return material.key;
  }
  if (envelope.kdf === "scrypt") {
    if (!material.passphrase) {
      throw new Error("vault: passphrase required for scrypt vault");
    }
    if (!envelope.salt) {
      throw new Error("vault: missing salt");
    }
    const salt = Buffer.from(envelope.salt, "base64");
    return deriveScryptKey(
      material.passphrase,
      salt,
      scryptParamsFromEnvelope(envelope),
    );
  }
  throw new Error("vault: unknown kdf");
}

export function emptyPayload(): VaultPayload {
  return { entries: {} };
}

export function safeEqualUtf8(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
