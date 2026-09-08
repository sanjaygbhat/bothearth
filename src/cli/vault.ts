/**
 * `modelbot vault set|get|rm|ls|rotate`.
 * Values never written to audit/events; get prints value to stdout only.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfigDoc } from "../config/load.ts";
import { openVault } from "../vault/index.ts";
import type { VaultOpenOptions } from "../vault/types.ts";
import { configPath, defaultDataDir, expandHome, modelbotHome, parseFlags } from "./paths.ts";

function vaultOpts(flags: Record<string, string>): VaultOpenOptions {
  const explicitPath = flags.path ?? process.env.MODELBOT_VAULT_PATH;
  const cfgPath = flags.config ?? process.env.MODELBOT_CONFIG ?? configPath(modelbotHome(flags.home));
  const configured = !explicitPath && existsSync(cfgPath)
    ? loadConfigDoc(cfgPath).vault as { path: string; keychain: "auto" | "passphrase" }
    : undefined;
  const path = resolve(expandHome(explicitPath ?? configured?.path ?? join(defaultDataDir(), "vault.enc")));
  const opts: VaultOpenOptions = { path };

  if (flags.passphrase || flags["key-hex"]) {
    throw new Error("vault: secret-bearing --passphrase/--key-hex arguments are forbidden");
  }
  if ((flags.keychain ?? configured?.keychain) === "passphrase") {
    throw new Error("vault: passphrase unlock requires an interactive credential helper");
  }
  opts.keychain = "auto";
  return opts;
}

async function readValue(flags: Record<string, string>): Promise<string> {
  if (flags.value !== undefined) {
    throw new Error("vault: --value is forbidden; use stdin or --value-file mode 0600");
  }
  if (flags["value-file"]) {
    return readFileSync(flags["value-file"], "utf8").replace(/\n$/, "");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const s = Buffer.concat(chunks).toString("utf8").replace(/\n$/, "");
  if (!s) {
    console.error("vault: missing value (pass --value-file or stdin)");
    process.exit(2);
  }
  return s;
}

export async function runVaultCli(argv: string[]): Promise<void> {
  const sub = argv[0];
  const { flags, positionals } = parseFlags(argv.slice(1));
  const opts = vaultOpts(flags);

  if (sub === "set") {
    const name = positionals[0];
    if (!name) {
      console.error("usage: modelbot vault set <name> [--value-file F]");
      process.exit(2);
    }
    const value = await readValue(flags);
    // openVault creates key material if file missing; first set writes 0600 file.
    // Never createVault on decrypt failure — that would overwrite an existing vault.
    const vault = await openVault(opts);
    await vault.set(name, value);
    console.log(`set ${name}`);
    return;
  }

  if (sub === "get") {
    const name = positionals[0];
    if (!name) {
      console.error("usage: modelbot vault get <name>");
      process.exit(2);
    }
    const vault = await openVault(opts);
    const v = await vault.get(name);
    if (v === undefined) {
      console.error(`missing: ${name}`);
      process.exit(1);
    }
    process.stdout.write(v);
    if (!v.endsWith("\n")) process.stdout.write("\n");
    return;
  }

  if (sub === "rm" || sub === "delete") {
    const name = positionals[0];
    if (!name) {
      console.error("usage: modelbot vault rm <name>");
      process.exit(2);
    }
    const vault = await openVault(opts);
    await vault.delete(name);
    console.log(`rm ${name}`);
    return;
  }

  if (sub === "ls" || sub === "list") {
    const vault = await openVault(opts);
    const names = await vault.list();
    for (const n of names) console.log(n);
    return;
  }

  if (sub === "rotate") {
    const vault = await openVault(opts);
    await vault.rotate();
    console.log("rotated");
    return;
  }

  console.error(
    "usage: modelbot vault set|get|rm|ls|rotate [--path P] [--value-file F]",
  );
  process.exit(2);
}
