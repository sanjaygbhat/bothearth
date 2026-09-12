/**
 * `modelbot init` — non-interactive first-run.
 * Uses the OS keychain or an encrypted systemd credential without a prompt.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";
import {
  CONFIG_VERSION,
  loadConfigDoc,
  loadModelbotSchema,
  validateModelbotConfig,
} from "../config/load.ts";
import { detectRuntime } from "../sandbox/detect.ts";
import { createVault } from "../vault/index.ts";
import {
  deleteStoredOsKey,
  vaultKeyAccount,
} from "../vault/providers.ts";
import { VAULT_KEYCHAIN_SERVICE } from "../vault/types.ts";
import {
  configPath,
  defaultDataDir,
  expandHome,
  modelbotHome,
  tokensPath,
} from "./paths.ts";
import { mintRandomToken, writeTokensFile } from "./tokens.ts";

const here = dirname(fileURLToPath(import.meta.url));

interface InitOptions {
  home?: string;
  force?: boolean;
  skipDetect?: boolean;
  skipImages?: boolean;
  keychain?: "auto" | "passphrase";
  dataDir?: string;
  bind?: string;
  port?: number;
  /** Quiet: print the next command only. */
  quiet?: boolean;
  /**
   * Discard the OS-stored vault master key and start a new, empty vault.
   * Explicit flag only: a new master key permanently orphans an existing vault.
   */
  resetVaultKey?: boolean;
}

function parseInitFlags(argv: string[]): InitOptions {
  const opts: InitOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--force") opts.force = true;
    else if (a === "--skip-detect") opts.skipDetect = true;
    else if (a === "--skip-images") opts.skipImages = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--reset-vault-key") opts.resetVaultKey = true;
    else if (a === "--home" && argv[i + 1]) {
      opts.home = argv[++i];
    } else if (a === "--data-dir" && argv[i + 1]) {
      opts.dataDir = argv[++i];
    } else if (a === "--bind" && argv[i + 1]) {
      opts.bind = argv[++i];
    } else if (a === "--port" && argv[i + 1]) {
      opts.port = Number(argv[++i]);
    } else if (a === "--keychain" && argv[i + 1]) {
      opts.keychain = argv[++i] as "auto" | "passphrase";
    }
  }
  if (process.env.MODELBOT_INIT_FORCE === "1") opts.force = true;
  if (process.env.MODELBOT_INIT_SKIP_DETECT === "1") opts.skipDetect = true;
  return opts;
}

function writeMode0600(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

/**
 * Removes the OS-stored master key and moves any now-undecryptable vault aside.
 * Only ever reached via the explicit `--reset-vault-key` flag. Nothing secret is
 * copied anywhere: the moved file is the same ciphertext, and the old key is gone.
 */
function resetVaultKeyMaterial(vaultPath: string, quiet?: boolean): void {
  // This vault's own key only. The legacy machine-wide `master-key` item stays: other
  // ModelBot homes may still open their vaults with it, and a reset here must never
  // reach across and brick them — the bug this whole scheme exists to prevent.
  deleteStoredOsKey(VAULT_KEYCHAIN_SERVICE, vaultKeyAccount(vaultPath));
  if (existsSync(vaultPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const moved = `${vaultPath}.unreadable-${stamp}`;
    renameSync(vaultPath, moved);
    if (!quiet) {
      console.log(`vault: previous vault moved to ${moved}`);
      console.log(
        "vault: that file stays encrypted with the old master key and cannot be read again",
      );
    }
  }
  if (!quiet) {
    console.log("vault: stored master key removed; minting a new one");
  }
}

/** `--reset-vault-key` on an already-initialized home: touch the vault only. */
async function resetVaultKeyOnly(
  cfgFile: string,
  quiet?: boolean,
): Promise<void> {
  const doc = loadConfigDoc(cfgFile);
  const vault = doc.vault as { path?: string; keychain?: string } | undefined;
  if (vault?.keychain === "passphrase") {
    throw new Error(
      "vault: this host unlocks its vault with a passphrase, so there is no stored key to reset.",
    );
  }
  if (!vault?.path) {
    throw new Error(`vault: no vault.path in ${cfgFile}`);
  }
  const vaultPath = expandHome(vault.path);
  resetVaultKeyMaterial(vaultPath, quiet);
  await createVault({ path: vaultPath, keychain: "auto" });
  if (!quiet) {
    console.log(`vault: new empty vault created at ${vaultPath}`);
  }
  console.log("vault_reset: ok");
}

export async function runInit(argv: string[] = []): Promise<void> {
  const opts = parseInitFlags(argv);
  if (opts.keychain && opts.keychain !== "auto") {
    throw new Error("vault: CLI passphrase unlock is unavailable. Use the OS keychain with --keychain auto, or an encrypted systemd credential on a headless server (docs/REMOTE-DEPLOY.md).");
  }
  const home = modelbotHome(opts.home);
  const cfgFile = configPath(home);
  const tokFile = tokensPath(home);

  if (existsSync(cfgFile) && opts.resetVaultKey && !opts.force) {
    // Reset the vault key without rewriting config or rotating tokens.
    await resetVaultKeyOnly(cfgFile, opts.quiet);
    return;
  }

  if (existsSync(cfgFile) && !opts.force) {
    throw new Error(
      `already initialized: ${cfgFile} (pass --force to overwrite)`,
    );
  }

  mkdirSync(home, { recursive: true });

  let runtimeNote = "skipped";
  if (!opts.skipDetect) {
    try {
      const rt = await detectRuntime();
      runtimeNote = `${rt.kind} binary=${rt.binary}`;
      if (!opts.quiet) {
        console.log(`runtime: ${runtimeNote}`);
      }
    } catch (e) {
      runtimeNote = `none (${e instanceof Error ? e.message : String(e)})`;
      if (!opts.quiet) {
        console.warn(`runtime: ${runtimeNote}`);
        console.warn(
          "hint: install OrbStack / Colima / Docker Desktop / Podman",
        );
      }
    }
  }

  if (!opts.skipImages && !opts.quiet) {
    console.log(
      "images: ensure modelbot/computer:dev + modelbot/shell:dev (modelbot image pull|build)",
    );
  }

  const dataDir = expandHome(opts.dataDir ?? defaultDataDir());
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "computers"), { recursive: true });

  // Zero-config: only what this install actually decided. Every other key comes
  // from the defaults in src/config/load.ts, so a normal user never edits this
  // file. `src/config/example.yaml` (copied next to it) is the full reference.
  // Limits (agent.max_steps, agent.stall_sec, agent.spend_cap_usd,
  // policy.approval_ttl_sec, takeover.ttl_sec) are deliberately absent: writing
  // today's default pins it forever, and an install from an older ModelBot then
  // keeps a limit the daemon has since raised.
  const doc: Record<string, unknown> = {
    version: 1,
    config_version: CONFIG_VERSION,
    data_dir: dataDir,
    adapters: {
      default: "openai_compat",
      openai_compat: {
        base_url: "https://api.openai.com/v1",
        model: "gpt-5.5",
        api_key_vault: "providers/openai",
      },
    },
  };
  if (opts.bind) doc.bind = opts.bind;
  if (opts.port) doc.port = opts.port;

  validateModelbotConfig(doc, loadModelbotSchema());

  const vaultPath = join(dataDir, "vault.enc");
  if (opts.resetVaultKey) {
    resetVaultKeyMaterial(vaultPath, opts.quiet);
  }
  await createVault({ path: vaultPath, keychain: "auto" });

  // A failed vault setup must not leave an apparently initialized installation.
  const yamlText = stringifyYaml(doc, { lineWidth: 0 });
  writeMode0600(cfgFile, yamlText.endsWith("\n") ? yamlText : `${yamlText}\n`);

  const tokens = {
    mcp_token: mintRandomToken(32),
    bootstrap_token: mintRandomToken(32),
  };
  writeTokensFile(tokFile, tokens);

  // Also drop a copy under data_dir for operators who look there.
  writeTokensFile(join(dataDir, "tokens.json"), tokens);

  if (!opts.quiet) {
    console.log(`config: ${cfgFile}`);
    console.log(`tokens: ${tokFile} (mode 0600)`);
    console.log(`vault: ${vaultPath}`);
    console.log(`data_dir: ${dataDir}`);
  }
  // Never a URL: the link `start` prints is minted then, and this one is dead
  // the moment `start` mints its own.
  console.log("Next: modelbot start");

  try {
    copyFileSync(
      join(here, "../config/example.yaml"),
      join(home, "example.yaml"),
    );
  } catch {
    /* ignore */
  }
}
