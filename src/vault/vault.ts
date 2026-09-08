/**
 * Vault v1 — encrypted host secrets file.
 */
import {
  decryptPayload,
  deriveScryptKey,
  emptyPayload,
  encryptPayload,
  envelopeNeedsReWrap,
  randomMasterKey,
  randomSalt,
  resolveFileKey,
  SCRYPT_PARAMS_CURRENT,
} from "./crypto.ts";
import {
  assertMode0600,
  readEnvelope,
  writeEnvelopeAtomic,
} from "./file.ts";
import { selectKeyProvider } from "./providers.ts";
import type {
  KeyMaterial,
  KeyProvider,
  Vault,
  VaultFileEnvelope,
  VaultOpenOptions,
  VaultPayload,
} from "./types.ts";

function assertName(name: string): void {
  if (!name) {
    throw new Error("vault: entry name required");
  }
  if (name.includes("\0") || name.length > 256) {
    throw new Error("vault: invalid entry name");
  }
}

function wrapPayload(
  material: KeyMaterial,
  payload: VaultPayload,
): VaultFileEnvelope {
  if (material.kind === "passphrase") {
    if (!material.passphrase) {
      throw new Error("vault: passphrase required for scrypt vault");
    }
    const salt = randomSalt();
    const fileKey = deriveScryptKey(
      material.passphrase,
      salt,
      SCRYPT_PARAMS_CURRENT,
    );
    return encryptPayload(fileKey, payload, {
      kdf: "scrypt",
      salt,
      params: SCRYPT_PARAMS_CURRENT,
    });
  }
  return encryptPayload(material.key, payload, { kdf: "raw" });
}

/**
 * The legacy machine-wide key has just been proved to open this vault, so give the vault
 * its own OS-store item holding the same key. `store` verifies by read-back, so a partial
 * write fails loudly instead of leaving an unopenable vault. The legacy item is left in
 * place: other homes may still need it, and it is not ours to delete.
 */
async function adoptOwnAccount(
  provider: KeyProvider,
  material: KeyMaterial,
): Promise<void> {
  if (material.fromLegacyAccount) await provider.store?.(material.key);
}

class FileVault implements Vault {
  readonly path: string;
  private material: KeyMaterial;
  private readonly providerStore: ((key: Buffer) => Promise<void>) | undefined;

  constructor(
    path: string,
    material: KeyMaterial,
    providerStore?: (key: Buffer) => Promise<void>,
  ) {
    this.path = path;
    this.material = material;
    this.providerStore = providerStore;
  }

  private loadPayload(): VaultPayload {
    const env = readEnvelope(this.path);
    if (!env) return emptyPayload();
    const fileKey = resolveFileKey(env, this.material);
    return decryptPayload(fileKey, env);
  }

  private persist(payload: VaultPayload): void {
    writeEnvelopeAtomic(this.path, wrapPayload(this.material, payload));
    assertMode0600(this.path);
  }

  async get(name: string): Promise<string | undefined> {
    assertName(name);
    const payload = this.loadPayload();
    return payload.entries[name];
  }

  async set(name: string, value: string): Promise<void> {
    assertName(name);
    const payload = this.loadPayload();
    payload.entries[name] = value;
    this.persist(payload);
  }

  async delete(name: string): Promise<void> {
    assertName(name);
    const payload = this.loadPayload();
    if (!(name in payload.entries)) return;
    delete payload.entries[name];
    this.persist(payload);
  }

  async list(): Promise<string[]> {
    const payload = this.loadPayload();
    return Object.keys(payload.entries).sort();
  }

  async rotate(): Promise<void> {
    const payload = this.loadPayload();
    if (this.material.kind === "passphrase") {
      // New scrypt salt + nonce; same passphrase.
      this.persist(payload);
      return;
    }
    const next = randomMasterKey();
    if (this.providerStore) {
      await this.providerStore(next);
    }
    this.material = { ...this.material, key: next };
    this.persist(payload);
  }
}

/**
 * Open or create a vault at opts.path.
 * Creates empty vault on first write; open succeeds if file missing.
 * Legacy envelopes (v=1 or scrypt N=16384) re-wrap to current params after unlock.
 */
export async function openVault(opts: VaultOpenOptions): Promise<Vault> {
  const existing = readEnvelope(opts.path);
  const provider = selectKeyProvider({
    keychain: opts.keychain,
    passphrase: opts.passphrase,
    provider: opts.provider,
    vaultPath: opts.path,
    // Only a vault that already exists may need the pre-split machine-wide key.
    legacyAccountFallback: Boolean(existing),
  });
  const createKey = !existing;
  const material = await provider.resolve(createKey);

  if (existing) {
    // Fail closed: wrong key / passphrase must throw.
    const fileKey = resolveFileKey(existing, material);
    const payload = decryptPayload(fileKey, existing);
    await adoptOwnAccount(provider, material);
    if (envelopeNeedsReWrap(existing)) {
      writeEnvelopeAtomic(opts.path, wrapPayload(material, payload));
      assertMode0600(opts.path);
    }
  }

  return new FileVault(opts.path, material, provider.store?.bind(provider));
}

/**
 * Create a new empty vault file (0600) with the selected provider.
 */
export async function createVault(opts: VaultOpenOptions): Promise<Vault> {
  const existing = readEnvelope(opts.path);
  const provider = selectKeyProvider({
    keychain: opts.keychain,
    passphrase: opts.passphrase,
    provider: opts.provider,
    vaultPath: opts.path,
    legacyAccountFallback: Boolean(existing),
  });
  const material = await provider.resolve(true);
  const vault = new FileVault(
    opts.path,
    material,
    provider.store?.bind(provider),
  );
  // Force initial empty encrypt so file exists with 0600. On a re-init over a surviving
  // vault file this also proves the key opens it before anything is rewritten.
  await vault.set("__vault_init__", "1");
  await vault.delete("__vault_init__");
  await adoptOwnAccount(provider, material);
  return vault;
}
