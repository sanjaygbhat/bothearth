/**
 * Vault master-key providers.
 * - keychain-macos: `security add/find-generic-password`
 * - secret-service-linux: `secret-tool`
 * - passphrase: scrypt at file layer (no OS store)
 * - env: MODELBOT_VAULT_KEY_HEX (CI only; not a production primary)
 *
 * ACL limits: see KEYCHAIN.md — broad `-T node` ACL is not a security boundary.
 */
import { constants, openSync, fstatSync, readFileSync, closeSync, existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { randomMasterKey, safeEqualUtf8 } from "./crypto.ts";
import type { KeyMaterial, KeyProvider } from "./types.ts";
import {
  VAULT_KEYCHAIN_ACCOUNT,
  VAULT_KEYCHAIN_SERVICE,
} from "./types.ts";

const ENV_KEY_HEX = "MODELBOT_VAULT_KEY_HEX";

/**
 * One OS-store item per vault file, never one per machine.
 *
 * Every ModelBot home owns its own `vault.enc` (the CLI's `~/.modelbot`, the Mac app's
 * Application Support home, and any scratch home a test or script creates). Before this,
 * all of them shared the single account `master-key`, so minting or resetting a key for
 * one home silently made every other home's vault undecryptable — the app then dead-ended
 * on a vault it could never unlock.
 *
 * The account is derived from the vault file's real path rather than from the home
 * directory: it is the file the key actually unlocks, so two homes configured to share one
 * `data_dir` correctly keep sharing one key instead of bricking each other. The directory
 * is resolved through symlinks (the file itself may not exist yet, on first init).
 */
export function vaultKeyAccount(vaultPath: string): string {
  const dir = dirname(vaultPath);
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    /* not created yet: the literal path is still a stable identity */
  }
  const digest = createHash("sha256")
    .update(join(real, basename(vaultPath)))
    .digest("hex")
    .slice(0, 16);
  return `${VAULT_KEYCHAIN_ACCOUNT}:${digest}`;
}

function run(
  bin: string,
  args: string[],
  opts?: { input?: string },
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(bin, args, {
    input: opts?.input,
    encoding: "utf8",
    env: process.env,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/** Injectable so tests can drive a fake `security` / `secret-tool` without a real OS store. */
export type KeyStoreRunner = (
  bin: string,
  args: string[],
  opts?: { input?: string },
) => { status: number | null; stdout: string; stderr: string };

const KEY_HEX = /^[0-9a-fA-F]{64}$/;

function parseHexKey(hex: string): Buffer {
  const clean = hex.trim();
  if (!KEY_HEX.test(clean)) {
    throw new Error("vault: master key must be 64 hex chars (32 bytes)");
  }
  return Buffer.from(clean, "hex");
}

/**
 * An OS-store item that exists but is not a valid key is never overwritten automatically:
 * minting a fresh master key would make an existing vault permanently unreadable.
 * Never include the stored value itself — it may be a real secret.
 */
function malformedStoredKey(where: string, length: number): Error {
  return new Error(
    [
      "vault: the stored vault master key is not usable.",
      `  ${where}`,
      `  It holds ${length} character(s); a valid key is 64 hexadecimal characters.`,
      "This is usually left over from an older ModelBot version that saved a command-line",
      "flag instead of the key. ModelBot will not replace it on its own, because a new",
      "master key makes any existing vault permanently unreadable.",
      "To discard the unusable key and start a new, empty vault, run:",
      "  modelbot init --reset-vault-key",
      "If the vault holds entries you need, restore them from your own backup first —",
      "they cannot be recovered without the original master key.",
    ].join("\n"),
  );
}

/** Reads an OS-store value, refusing anything that is not a real key. */
function keyFromStoredValue(raw: string, where: string): Buffer {
  const clean = raw.trim();
  if (!KEY_HEX.test(clean)) throw malformedStoredKey(where, clean.length);
  return Buffer.from(clean, "hex");
}

export function envKeyProvider(envName: string = ENV_KEY_HEX): KeyProvider {
  return {
    kind: "env",
    async resolve(createIfMissing: boolean): Promise<KeyMaterial> {
      const hex = process.env[envName];
      if (hex && hex.trim()) {
        return { kind: "env", key: parseHexKey(hex) };
      }
      if (!createIfMissing) {
        throw new Error(`vault: missing env ${envName}`);
      }
      const key = randomMasterKey();
      process.env[envName] = key.toString("hex");
      return { kind: "env", key };
    },
    async store(key: Buffer): Promise<void> {
      process.env[envName] = key.toString("hex");
    },
  };
}

/** systemd decrypts LoadCredentialEncrypted into this service's private credentials directory. */
export function systemdCredentialProvider(directory: string): KeyProvider {
  return {
    kind: "systemd-credential",
    async resolve() {
      const fd = openSync(join(directory, "modelbot-vault"), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 65 || (stat.mode & 0o077) !== 0 ||
            (process.getuid && stat.uid !== process.getuid())) throw new Error("vault: invalid systemd credential permissions or size");
        return { kind: "systemd-credential", key: parseHexKey(readFileSync(fd, "utf8")) };
      } finally { closeSync(fd); }
    },
    async store() { throw new Error("vault: rotate the encrypted systemd credential and vault together; automatic key rotation is unavailable"); },
  };
}

export function passphraseKeyProvider(passphrase: string): KeyProvider {
  if (!passphrase) {
    throw new Error("vault: empty passphrase");
  }
  const placeholder = Buffer.alloc(32, 0);
  return {
    kind: "passphrase",
    async resolve(): Promise<KeyMaterial> {
      return { kind: "passphrase", key: placeholder, passphrase };
    },
  };
}

function macosItemLabel(service: string, account: string): string {
  return `macOS keychain item: service "${service}", account "${account}".`;
}

function findMacosKeychain(
  service: string,
  account: string,
  exec: KeyStoreRunner,
) {
  return exec("security", [
    "find-generic-password",
    "-s",
    service,
    "-a",
    account,
    "-w",
  ]);
}

/**
 * Values ModelBot itself composes — the fixed service, the derived account, the
 * key hex. `security -i` tokenises its stdin on whitespace and honours double
 * quotes, so anything outside this set could change the command it runs. All
 * three are generated, never user input; refusing is a fail-closed assertion,
 * not an escaping strategy.
 */
const SECURITY_TOKEN = /^[A-Za-z0-9._:@+-]+$/;

function securityToken(value: string, what: string): string {
  if (!SECURITY_TOKEN.test(value)) {
    // Never echo the value: for the key this would defeat the whole point.
    throw new Error(`vault: the macOS keychain ${what} contains characters ModelBot cannot pass safely.`);
  }
  return `"${value}"`;
}

/**
 * The master key is written over stdin and NEVER as an argv element.
 * On macOS any same-user process can read another's full command line
 * (`ps -ww -o args`), and this key decrypts every credential in `vault.enc`, so
 * `add-generic-password … -w <hex>` published the whole vault to every process
 * the user runs. `security -i` reads its sub-command from stdin instead: the key
 * crosses a pipe, touches no argv and no temporary file.
 *
 * `-w` still carries its value inline *within that stdin line*, which is what
 * avoids the historic quirk where a trailing `-w` made `security` prompt and
 * silently store an empty password (or the following flag) while exiting 0.
 * The read-back below stays regardless: it is what makes any future silent
 * miswrite loud instead of leaving a vault that can never be unlocked.
 */
function storeMacosKeychain(
  service: string,
  account: string,
  key: Buffer,
  exec: KeyStoreRunner,
): void {
  const hex = key.toString("hex");
  // Prefer dedicated keychain / prompt-on-unlock over broad -T node ACL.
  const command = [
    "add-generic-password",
    "-s",
    securityToken(service, "service"),
    "-a",
    securityToken(account, "account"),
    "-U",
    "-w",
    securityToken(hex, "key"),
  ].join(" ");
  const add = exec("security", ["-i"], { input: `${command}\n` });
  if (add.status !== 0) {
    throw new Error(
      `vault: security add-generic-password failed: ${add.stderr.trim() || String(add.status)}`,
    );
  }
  const back = findMacosKeychain(service, account, exec);
  if (back.status !== 0 || !safeEqualUtf8(back.stdout.trim(), hex)) {
    throw new Error(
      [
        "vault: the vault master key was not stored correctly in the macOS keychain.",
        `  ${macosItemLabel(service, account)}`,
        "ModelBot wrote the key and read it back, and the two did not match, so it",
        "stopped rather than leave a vault it could never unlock.",
        "Check that the `security` command works and the login keychain is unlocked, then",
        "run: modelbot init --reset-vault-key",
      ].join("\n"),
    );
  }
}

/**
 * `legacyAccount` is only ever passed when a vault file already exists: an existing vault
 * may have been encrypted under the old machine-wide `master-key` item, and that is the
 * only key that can still open it. A vault being created fresh never adopts it.
 */
export function macosKeychainProvider(
  service: string = VAULT_KEYCHAIN_SERVICE,
  account: string = VAULT_KEYCHAIN_ACCOUNT,
  exec: KeyStoreRunner = run,
  legacyAccount?: string,
): KeyProvider {
  return {
    kind: "keychain-macos",
    async resolve(createIfMissing: boolean): Promise<KeyMaterial> {
      const found = findMacosKeychain(service, account, exec);
      // status 0 means the item exists. Empty or malformed is a corrupt item, not a
      // missing one: fail loudly instead of minting a key that orphans the vault.
      if (found.status === 0) {
        return {
          kind: "keychain-macos",
          key: keyFromStoredValue(
            found.stdout,
            macosItemLabel(service, account),
          ),
        };
      }
      if (legacyAccount && legacyAccount !== account) {
        const legacy = findMacosKeychain(service, legacyAccount, exec);
        if (legacy.status === 0) {
          return {
            kind: "keychain-macos",
            key: keyFromStoredValue(
              legacy.stdout,
              macosItemLabel(service, legacyAccount),
            ),
            fromLegacyAccount: true,
          };
        }
      }
      if (!createIfMissing) {
        throw new Error(
          `vault: no vault master key found. ${macosItemLabel(service, account)}\nRun \`modelbot init\` to create one.`,
        );
      }
      const key = randomMasterKey();
      storeMacosKeychain(service, account, key, exec);
      return { kind: "keychain-macos", key };
    },
    async store(key: Buffer): Promise<void> {
      storeMacosKeychain(service, account, key, exec);
    },
  };
}

function linuxItemLabel(service: string, account: string): string {
  return `Secret Service item: service "${service}", account "${account}".`;
}

function lookupLinuxSecret(
  service: string,
  account: string,
  exec: KeyStoreRunner,
) {
  return exec("secret-tool", ["lookup", "service", service, "account", account]);
}

function storeLinuxSecret(
  service: string,
  account: string,
  key: Buffer,
  exec: KeyStoreRunner,
): void {
  const hex = key.toString("hex");
  const add = exec(
    "secret-tool",
    [
      "store",
      "--label",
      "ModelBot vault master key",
      "service",
      service,
      "account",
      account,
    ],
    { input: hex },
  );
  if (add.status !== 0) {
    throw new Error(
      `vault: secret-tool store failed: ${add.stderr.trim() || String(add.status)}`,
    );
  }
  const back = lookupLinuxSecret(service, account, exec);
  if (back.status !== 0 || !safeEqualUtf8(back.stdout.trim(), hex)) {
    throw new Error(
      [
        "vault: the vault master key was not stored correctly in the Secret Service.",
        `  ${linuxItemLabel(service, account)}`,
        "ModelBot wrote the key and read it back, and the two did not match, so it",
        "stopped rather than leave a vault it could never unlock.",
        "Check that `secret-tool` works and the keyring is unlocked, then run:",
        "  modelbot init --reset-vault-key",
      ].join("\n"),
    );
  }
}

/** Same per-vault-file account and legacy fallback as the macOS provider above. */
export function linuxSecretToolProvider(
  service: string = VAULT_KEYCHAIN_SERVICE,
  account: string = VAULT_KEYCHAIN_ACCOUNT,
  exec: KeyStoreRunner = run,
  legacyAccount?: string,
): KeyProvider {
  return {
    kind: "secret-service-linux",
    async resolve(createIfMissing: boolean): Promise<KeyMaterial> {
      const found = lookupLinuxSecret(service, account, exec);
      if (found.status === 0) {
        return {
          kind: "secret-service-linux",
          key: keyFromStoredValue(
            found.stdout,
            linuxItemLabel(service, account),
          ),
        };
      }
      if (legacyAccount && legacyAccount !== account) {
        const legacy = lookupLinuxSecret(service, legacyAccount, exec);
        if (legacy.status === 0) {
          return {
            kind: "secret-service-linux",
            key: keyFromStoredValue(
              legacy.stdout,
              linuxItemLabel(service, legacyAccount),
            ),
            fromLegacyAccount: true,
          };
        }
      }
      if (!createIfMissing) {
        throw new Error(
          `vault: no vault master key found. ${linuxItemLabel(service, account)}\nRun \`modelbot init\` to create one.`,
        );
      }
      const key = randomMasterKey();
      storeLinuxSecret(service, account, key, exec);
      return { kind: "secret-service-linux", key };
    },
    async store(key: Buffer): Promise<void> {
      storeLinuxSecret(service, account, key, exec);
    },
  };
}

/**
 * Deletes ONE OS-store master key. Only `modelbot init --reset-vault-key` calls this:
 * the next key mint orphans any existing vault, so it is never automatic.
 * Missing item is success — the point is to end with no key stored.
 *
 * Callers pass this vault's own account (`vaultKeyAccount`). The legacy machine-wide
 * `master-key` item is deliberately left alone: other homes may still be opening their
 * vaults with it, and removing it would brick them — which is exactly the failure that
 * per-vault accounts exist to prevent.
 */
export function deleteStoredOsKey(
  service: string = VAULT_KEYCHAIN_SERVICE,
  account: string = VAULT_KEYCHAIN_ACCOUNT,
  exec: KeyStoreRunner = run,
): void {
  const p = platform();
  const r = p === "darwin"
    ? exec("security", ["delete-generic-password", "-s", service, "-a", account])
    : exec("secret-tool", ["clear", "service", service, "account", account]);
  if (r.status !== 0 && findOsKey(service, account, exec).status === 0) {
    throw new Error(
      `vault: could not remove the stored master key: ${r.stderr.trim() || String(r.status)}`,
    );
  }
}

function findOsKey(service: string, account: string, exec: KeyStoreRunner) {
  return platform() === "darwin"
    ? findMacosKeychain(service, account, exec)
    : lookupLinuxSecret(service, account, exec);
}

/**
 * `vaultPath` scopes the OS-store item to that one vault file; omit it only for callers
 * with no vault in hand, which then get the legacy machine-wide account.
 * `legacyFallback` must be true only when the vault file already exists (see above).
 */
export function detectOsKeyProvider(
  vaultPath?: string,
  legacyFallback = false,
): KeyProvider | null {
  const account = vaultPath ? vaultKeyAccount(vaultPath) : VAULT_KEYCHAIN_ACCOUNT;
  const legacy = legacyFallback ? VAULT_KEYCHAIN_ACCOUNT : undefined;
  const p = platform();
  if (p === "darwin") {
    return macosKeychainProvider(VAULT_KEYCHAIN_SERVICE, account, run, legacy);
  }
  if (p === "linux") {
    return linuxSecretToolProvider(VAULT_KEYCHAIN_SERVICE, account, run, legacy);
  }
  return null;
}

/**
 * Select provider: explicit → MODELBOT_VAULT_KEY_HEX → OS keychain (auto) → passphrase.
 * Never uses a long-lived passphrase env as primary (SECURITY.md).
 */
export function selectKeyProvider(opts: {
  keychain?: "auto" | "passphrase";
  passphrase?: string;
  provider?: KeyProvider;
  /** Scopes the OS-store key to this vault file. */
  vaultPath?: string;
  /** True only when the vault file exists and may predate per-vault accounts. */
  legacyAccountFallback?: boolean;
}): KeyProvider {
  if (opts.provider) return opts.provider;

  const envHex = process.env.MODELBOT_VAULT_KEY_HEX;
  if (envHex && envHex.trim()) {
    return envKeyProvider();
  }

  const mode = opts.keychain ?? "auto";
  if (mode === "passphrase") {
    if (!opts.passphrase) {
      throw new Error("vault: passphrase required when keychain=passphrase");
    }
    return passphraseKeyProvider(opts.passphrase);
  }

  const directory = process.env.CREDENTIALS_DIRECTORY;
  if (directory && existsSync(join(directory, "modelbot-vault"))) return systemdCredentialProvider(directory);

  const os = detectOsKeyProvider(opts.vaultPath, opts.legacyAccountFallback);
  if (os) return os;

  if (opts.passphrase) {
    return passphraseKeyProvider(opts.passphrase);
  }
  throw new Error(
    "vault: no key provider (set passphrase, OS keychain, or MODELBOT_VAULT_KEY_HEX for CI)",
  );
}
