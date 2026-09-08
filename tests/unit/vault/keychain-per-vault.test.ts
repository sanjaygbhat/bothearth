/**
 * One OS-store item per vault file.
 *
 * The bug being locked out: every ModelBot home shared the single keychain account
 * `master-key`, so minting or resetting a key for one home silently made every other
 * home's vault.enc undecryptable.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  macosKeychainProvider,
  linuxSecretToolProvider,
  vaultKeyAccount,
  type KeyStoreRunner,
} from "../../../src/vault/providers.ts";
import { createVault, openVault } from "../../../src/vault/vault.ts";
import { VAULT_KEYCHAIN_ACCOUNT } from "../../../src/vault/types.ts";

const SERVICE = "com.modelbot.test-vault";
const LEGACY_KEY = "b".repeat(64);

function tmpVault(name = "vault.enc"): string {
  return join(mkdtempSync(join(tmpdir(), "mb-perhome-")), name);
}

/**
 * Fake `security` that, unlike the real store, is keyed by account — the whole point of
 * the fix is that the account is no longer a constant.
 */
function fakeSecurity(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const calls: string[][] = [];
  const exec: KeyStoreRunner = (bin, args, io) => {
    calls.push([bin, ...args]);
    // Writes arrive through `security -i` on stdin so the master key never
    // reaches argv; reads are still ordinary argv sub-commands.
    const argv = args[0] === "-i"
      ? ((io?.input ?? "").trim().match(/"[^"]*"|\S+/g) ?? [])
        .map((t) => (t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t))
      : args;
    const acct = argv[argv.indexOf("-a") + 1] ?? "";
    const ok = { status: 0, stdout: "", stderr: "" };
    const missing = { status: 44, stdout: "", stderr: "could not be found" };
    switch (argv[0]) {
      case "add-generic-password":
        items.set(acct, argv[argv.indexOf("-w") + 1] ?? "");
        return ok;
      case "find-generic-password":
        return items.has(acct)
          ? { status: 0, stdout: `${items.get(acct)}\n`, stderr: "" }
          : missing;
      case "delete-generic-password":
        return items.delete(acct) ? ok : missing;
      default:
        throw new Error(`unexpected security call: ${argv[0]}`);
    }
  };
  return { exec, calls, items };
}

/** Same fake, spoken as `secret-tool`; the Linux provider carries the identical hazard. */
function fakeSecretTool(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const exec: KeyStoreRunner = (_bin, args, opts) => {
    const acct = args[args.indexOf("account") + 1] ?? "";
    if (args[0] === "store") {
      items.set(acct, opts?.input ?? "");
      return { status: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "lookup") {
      return items.has(acct)
        ? { status: 0, stdout: `${items.get(acct)}\n`, stderr: "" }
        : { status: 1, stdout: "", stderr: "no such secret" };
    }
    throw new Error(`unexpected secret-tool call: ${args[0]}`);
  };
  return { exec, items };
}

test("the account is derived from the vault file and differs per home", () => {
  const cli = vaultKeyAccount("/Users/x/ModelBot/vault.enc");
  const app = vaultKeyAccount("/Users/x/Library/Application Support/ModelBot/data/vault.enc");

  assert.match(cli, /^master-key:[0-9a-f]{16}$/);
  assert.notEqual(cli, app);
  assert.notEqual(cli, VAULT_KEYCHAIN_ACCOUNT);
  // Stable across calls: the key must still be findable on the next launch.
  assert.equal(cli, vaultKeyAccount("/Users/x/ModelBot/vault.enc"));
  // Two homes deliberately sharing one data_dir must keep sharing one key.
  assert.equal(
    vaultKeyAccount("/shared/data/vault.enc"),
    vaultKeyAccount("/shared/data/vault.enc"),
  );
});

test("minting a key for one vault leaves another vault's key untouched", async () => {
  const kc = fakeSecurity();
  const a = vaultKeyAccount("/home/a/vault.enc");
  const b = vaultKeyAccount("/home/b/vault.enc");

  const keyA = (await macosKeychainProvider(SERVICE, a, kc.exec).resolve(true)).key;
  const keyB = (await macosKeychainProvider(SERVICE, b, kc.exec).resolve(true)).key;

  assert.notDeepEqual(keyA, keyB);
  // Re-resolving A still returns A's key: B's mint did not rotate it.
  assert.deepEqual(
    (await macosKeychainProvider(SERVICE, a, kc.exec).resolve(false)).key,
    keyA,
  );
  assert.equal(kc.items.size, 2);
});

test("falls back to the legacy shared account and flags the material for migration", async () => {
  const kc = fakeSecurity({ [VAULT_KEYCHAIN_ACCOUNT]: LEGACY_KEY });
  const scoped = vaultKeyAccount("/home/a/vault.enc");
  const material = await macosKeychainProvider(
    SERVICE,
    scoped,
    kc.exec,
    VAULT_KEYCHAIN_ACCOUNT,
  ).resolve(false);

  assert.equal(material.key.toString("hex"), LEGACY_KEY);
  assert.equal(material.fromLegacyAccount, true);
});

test("without the legacy fallback a scoped-account miss is a hard miss", async () => {
  const kc = fakeSecurity({ [VAULT_KEYCHAIN_ACCOUNT]: LEGACY_KEY });
  const provider = macosKeychainProvider(SERVICE, vaultKeyAccount("/home/a/vault.enc"), kc.exec);
  // createIfMissing=false and no fallback: a fresh vault must never silently adopt the
  // machine-wide key, or the split would be undone on every new home.
  await assert.rejects(provider.resolve(false), /no vault master key found/);
});

test("secret-tool provider has the same per-vault accounts and legacy fallback", async () => {
  const st = fakeSecretTool({ [VAULT_KEYCHAIN_ACCOUNT]: LEGACY_KEY });
  const scoped = vaultKeyAccount("/home/a/vault.enc");

  const legacy = await linuxSecretToolProvider(
    SERVICE,
    scoped,
    st.exec,
    VAULT_KEYCHAIN_ACCOUNT,
  ).resolve(false);
  assert.equal(legacy.key.toString("hex"), LEGACY_KEY);
  assert.equal(legacy.fromLegacyAccount, true);

  const minted = await linuxSecretToolProvider(SERVICE, scoped, st.exec).resolve(true);
  assert.equal(st.items.get(scoped), minted.key.toString("hex"));
  assert.equal(st.items.get(VAULT_KEYCHAIN_ACCOUNT), LEGACY_KEY, "legacy left alone");
});

test("a legacy vault migrates to its own account on the first successful open", async () => {
  const path = tmpVault();
  const scoped = vaultKeyAccount(path);
  const kc = fakeSecurity({ [VAULT_KEYCHAIN_ACCOUNT]: LEGACY_KEY });

  // A vault written before the split: encrypted under the machine-wide key.
  const legacyProvider = macosKeychainProvider(SERVICE, VAULT_KEYCHAIN_ACCOUNT, kc.exec);
  const first = await createVault({ path, provider: legacyProvider });
  await first.set("providers/openai", "sk-canary");
  assert.equal(kc.items.size, 1, "still only the legacy item");

  // Opening it with the per-vault provider must succeed via the fallback and migrate.
  const migrating = macosKeychainProvider(SERVICE, scoped, kc.exec, VAULT_KEYCHAIN_ACCOUNT);
  const reopened = await openVault({ path, provider: migrating });
  assert.equal(await reopened.get("providers/openai"), "sk-canary");

  assert.equal(kc.items.get(scoped), LEGACY_KEY, "own account now holds the key");
  assert.equal(kc.items.get(VAULT_KEYCHAIN_ACCOUNT), LEGACY_KEY, "legacy item untouched");

  // And now it opens with no fallback at all — the migration is what makes a reset in
  // another home survivable.
  const standalone = await openVault({
    path,
    provider: macosKeychainProvider(SERVICE, scoped, kc.exec),
  });
  assert.equal(await standalone.get("providers/openai"), "sk-canary");
});

test("migration refuses to complete when the keychain reads back a different key", async () => {
  const path = tmpVault();
  const kc = fakeSecurity({ [VAULT_KEYCHAIN_ACCOUNT]: LEGACY_KEY });
  const legacyProvider = macosKeychainProvider(SERVICE, VAULT_KEYCHAIN_ACCOUNT, kc.exec);
  await (await createVault({ path, provider: legacyProvider })).set("a", "1");

  // Store silently keeps the old value: exactly the class of failure this guards.
  const lying: KeyStoreRunner = (bin, args, opts) =>
    args[0] === "-i"
      ? { status: 0, stdout: "", stderr: "" }
      : kc.exec(bin, args, opts);
  const provider = macosKeychainProvider(
    SERVICE,
    vaultKeyAccount(path),
    lying,
    VAULT_KEYCHAIN_ACCOUNT,
  );

  await assert.rejects(
    openVault({ path, provider }),
    /was not stored correctly in the macOS keychain/,
  );
});

test("a reset deletes only this vault's account, never the shared one", {
  skip: process.platform !== "darwin",
}, async () => {
  const kc = fakeSecurity({ [VAULT_KEYCHAIN_ACCOUNT]: LEGACY_KEY });
  const scoped = vaultKeyAccount("/home/a/vault.enc");
  await macosKeychainProvider(SERVICE, scoped, kc.exec).resolve(true);

  const { deleteStoredOsKey } = await import("../../../src/vault/providers.ts");
  // Mirrors what `init --reset-vault-key` now passes.
  deleteStoredOsKey(SERVICE, scoped, kc.exec);

  assert.equal(kc.items.has(scoped), false);
  assert.equal(kc.items.get(VAULT_KEYCHAIN_ACCOUNT), LEGACY_KEY);
});
