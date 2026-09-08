/**
 * Integration helpers for adapters, audit, and connectors.
 * Secrets stay in vault; callers receive values only in-process — never log them.
 */
import { randomBytes } from "node:crypto";
import type { AuditKeyProvider } from "../audit/key.ts";
import type { AdapterEndpointConfig } from "../types/contracts.ts";
import type { Vault } from "./types.ts";
import {
  VAULT_AUDIT_HMAC,
  VAULT_CONNECTORS_PREFIX,
  VAULT_PROVIDERS_PREFIX,
} from "./types.ts";

/** AuditKeyProvider backed by vault entry `audit/hmac` (hex or utf8). */
export function vaultAuditKeyProvider(vault: Vault): AuditKeyProvider {
  return {
    async getAuditHmacKey(): Promise<Buffer> {
      const raw = await vault.get(VAULT_AUDIT_HMAC);
      if (!raw) {
        throw new Error(`vault: missing ${VAULT_AUDIT_HMAC}`);
      }
      const hex = raw.trim();
      if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
        return Buffer.from(hex, "hex");
      }
      return Buffer.from(raw, "utf8");
    },
  };
}

/** Ensure an audit HMAC key exists; mint 32 random bytes as hex if missing. */
export async function ensureAuditHmacKey(vault: Vault): Promise<void> {
  const existing = await vault.get(VAULT_AUDIT_HMAC);
  if (existing) return;
  await vault.set(VAULT_AUDIT_HMAC, randomBytes(32).toString("hex"));
}

/**
 * Resolve provider API key: api_key_vault XOR api_key_env (ARCH §3).
 * Local endpoints may set neither → undefined.
 */
export async function resolveProviderApiKey(
  endpoint: AdapterEndpointConfig,
  vault: Vault,
): Promise<string | undefined> {
  const hasVault = Boolean(endpoint.api_key_vault);
  const hasEnv = Boolean(endpoint.api_key_env);
  if (hasVault && hasEnv) {
    throw new Error(
      "vault: api_key_vault and api_key_env are mutually exclusive",
    );
  }
  if (endpoint.api_key_vault) {
    const name = endpoint.api_key_vault.startsWith(VAULT_PROVIDERS_PREFIX)
      ? endpoint.api_key_vault
      : `${VAULT_PROVIDERS_PREFIX}${endpoint.api_key_vault}`;
    return vault.get(name);
  }
  if (endpoint.api_key_env) {
    return process.env[endpoint.api_key_env];
  }
  return undefined;
}

/**
 * Load connector MCP env map from vault names `connectors/<id>/<ENV>`.
 * Returns only requested keys; values never logged here.
 */
export async function loadConnectorEnv(
  vault: Vault,
  connectorId: string,
  envNames: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const envName of envNames) {
    const key = `${VAULT_CONNECTORS_PREFIX}${connectorId}/${envName}`;
    const val = await vault.get(key);
    if (val !== undefined) out[envName] = val;
  }
  return out;
}
