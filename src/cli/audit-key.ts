/**
 * HMAC key resolution for `modelbot audit verify`.
 * Precedence: --key-file, then MODELBOT_AUDIT_KEY_HEX / MODELBOT_AUDIT_KEY, else vault `audit/hmac`.
 */
import { readFileSync } from "node:fs";
import { loadConfigDoc } from "../config/load.ts";
import { VAULT_AUDIT_HMAC } from "../vault/types.ts";
import { configPath, expandHome, modelbotHome } from "./paths.ts";

export const AUDIT_VERIFY_KEY_HELP =
  "HMAC key: vault `" +
  VAULT_AUDIT_HMAC +
  "` (default); --key-file or MODELBOT_AUDIT_KEY_HEX / MODELBOT_AUDIT_KEY override when set";

export async function resolveAuditVerifyKey(
  flags: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Buffer> {
  if (flags["key-file"]) return readFileSync(flags["key-file"]);
  const hex = env.MODELBOT_AUDIT_KEY_HEX;
  if (hex) return Buffer.from(hex, "hex");
  const raw = env.MODELBOT_AUDIT_KEY;
  if (raw) return Buffer.from(raw, "utf8");

  const cfgPath = flags.config ?? env.MODELBOT_CONFIG ?? configPath(modelbotHome(flags.home));
  const config = loadConfigDoc(cfgPath) as {
    vault: { path: string; keychain: "auto" | "passphrase" };
  };
  if (config.vault.keychain === "passphrase") {
    throw new Error("audit verify: passphrase vault requires an interactive unlock helper");
  }
  const { openVault, vaultAuditKeyProvider } = await import("../vault/index.ts");
  const vault = await openVault({
    path: expandHome(config.vault.path),
    keychain: config.vault.keychain,
  });
  return vaultAuditKeyProvider(vault).getAuditHmacKey();
}
