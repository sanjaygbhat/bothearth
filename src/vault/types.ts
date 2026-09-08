/**
 * Vault types. Scope: provider API keys, connector MCP env, audit HMAC key.
 */

/** Current on-disk envelope. New writes always this. */
export const VAULT_FORMAT_VERSION = 2 as const;
/** Pre-AAD / implied scrypt N=16384. Still readable; re-wrapped on unlock. */
export const VAULT_FORMAT_VERSION_LEGACY = 1 as const;

export type VaultFormatVersion =
  | typeof VAULT_FORMAT_VERSION
  | typeof VAULT_FORMAT_VERSION_LEGACY;

export const VAULT_KEYCHAIN_SERVICE = "com.modelbot.vault";
/**
 * Legacy machine-wide account. New keys go to a per-vault-file account derived from it
 * (`vaultKeyAccount` in providers.ts); this one is still read, so vaults written before
 * the split keep opening.
 */
export const VAULT_KEYCHAIN_ACCOUNT = "master-key";

export const VAULT_AUDIT_HMAC = "audit/hmac";
export const VAULT_PROVIDERS_PREFIX = "providers/";
export const VAULT_CONNECTORS_PREFIX = "connectors/";

export type VaultKeychainMode = "auto" | "passphrase";

export type KeyProviderKind =
  | "keychain-macos"
  | "secret-service-linux"
  | "systemd-credential"
  | "passphrase"
  | "env";

export interface ScryptParams {
  n: number;
  r: number;
  p: number;
}

export interface VaultFileEnvelope {
  v: VaultFormatVersion;
  /** "scrypt" = passphrase-derived; "raw" = 32-byte master from keychain/env. */
  kdf: "scrypt" | "raw";
  /** scrypt N; required on v=2 scrypt; absent on v=1 (implied 16384). */
  n?: number;
  r?: number;
  p?: number;
  /** base64 salt (16+ bytes); present when kdf=scrypt. */
  salt?: string;
  /** base64 12-byte GCM nonce. */
  nonce: string;
  /** base64 ciphertext || authTag (tag last 16 bytes). */
  ciphertext: string;
}

export interface VaultPayload {
  entries: Record<string, string>;
}

export interface KeyMaterial {
  kind: KeyProviderKind;
  /** 32-byte AES key (unused placeholder when kind=passphrase). */
  key: Buffer;
  /** Passphrase retained only for scrypt re-wrap on rotate/set. */
  passphrase?: string;
  /**
   * The key came from the legacy machine-wide `master-key` item, not this vault's own
   * account. Once it has actually decrypted the vault, the caller copies it to the
   * per-vault account so a later reset elsewhere cannot take it away.
   */
  fromLegacyAccount?: boolean;
}

export interface KeyProvider {
  readonly kind: KeyProviderKind;
  resolve(createIfMissing: boolean): Promise<KeyMaterial>;
  store?(key: Buffer): Promise<void>;
}

export interface VaultOpenOptions {
  path: string;
  keychain?: VaultKeychainMode;
  passphrase?: string;
  /** Force provider (tests). Else: env → OS keychain (auto) → passphrase. */
  provider?: KeyProvider;
}

export interface Vault {
  readonly path: string;
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  /** Entry names only — never values. */
  list(): Promise<string[]>;
  /**
   * Re-encrypt with fresh salt/nonce. Keychain/env: mint new master key.
   * Passphrase: same passphrase, new scrypt salt.
   */
  rotate(): Promise<void>;
}
