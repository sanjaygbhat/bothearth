/**
 * Vault envelope: scrypt params + GCM AAD.
 */
import assert from "node:assert/strict";
import {
  createCipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  decryptPayload,
  resolveFileKey,
  SCRYPT_N_CURRENT,
  SCRYPT_N_LEGACY,
  SCRYPT_P,
  SCRYPT_R,
} from "../../../src/vault/crypto.ts";
import { parseEnvelope, readEnvelope } from "../../../src/vault/file.ts";
import { openVault } from "../../../src/vault/index.ts";
import { passphraseKeyProvider } from "../../../src/vault/providers.ts";
import {
  VAULT_FORMAT_VERSION,
  VAULT_FORMAT_VERSION_LEGACY,
} from "../../../src/vault/types.ts";

const PASS = "unit-test-passphrase-envelope";
const SECRET = "sk-legacy-fixture-SECRET";

function tmpVaultPath(): string {
  return join(mkdtempSync(join(tmpdir(), "mb-vault-env-")), "vault.enc");
}

/** v=1 fixture: scrypt N=16384, no AAD — matches the legacy on-disk format. */
function writeLegacyV1ScryptVault(
  path: string,
  passphrase: string,
  entries: Record<string, string>,
): void {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, {
    N: SCRYPT_N_LEGACY,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const plain = Buffer.from(JSON.stringify({ entries }), "utf8");
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = {
    v: VAULT_FORMAT_VERSION_LEGACY,
    kdf: "scrypt",
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    ciphertext: Buffer.concat([enc, tag]).toString("base64"),
  };
  writeFileSync(path, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
}

describe("scrypt params + migrate", () => {
  it("legacy N=16384 fixture opens, migrates, reopens with N=131072", async () => {
    const path = tmpVaultPath();
    writeLegacyV1ScryptVault(path, PASS, { "providers/openai": SECRET });

    const before = JSON.parse(readFileSync(path, "utf8")) as { v: number; n?: number };
    assert.equal(before.v, 1);
    assert.equal(before.n, undefined);

    const vault = await openVault({
      path,
      provider: passphraseKeyProvider(PASS),
    });
    assert.equal(await vault.get("providers/openai"), SECRET);

    const migrated = readEnvelope(path)!;
    assert.equal(migrated.v, VAULT_FORMAT_VERSION);
    assert.equal(migrated.n, SCRYPT_N_CURRENT);
    assert.equal(migrated.r, SCRYPT_R);
    assert.equal(migrated.p, SCRYPT_P);
    assert.equal(migrated.kdf, "scrypt");

    const again = await openVault({
      path,
      provider: passphraseKeyProvider(PASS),
    });
    assert.equal(await again.get("providers/openai"), SECRET);
    const still = readEnvelope(path)!;
    assert.equal(still.v, VAULT_FORMAT_VERSION);
    assert.equal(still.n, SCRYPT_N_CURRENT);
  });

  it("corrupted header fails closed", async () => {
    const path = tmpVaultPath();
    writeLegacyV1ScryptVault(path, PASS, { k: "v" });

    writeFileSync(path, "{not-json", { mode: 0o600 });
    await assert.rejects(
      () => openVault({ path, provider: passphraseKeyProvider(PASS) }),
      /malformed envelope/,
    );

    writeFileSync(
      path,
      JSON.stringify({
        v: 99,
        kdf: "scrypt",
        salt: "YWFhYWFhYWFhYWFhYWFhYQ==",
        nonce: "YWFhYWFhYWFhYWFh",
        ciphertext: "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=",
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      () => openVault({ path, provider: passphraseKeyProvider(PASS) }),
      /unsupported format version/,
    );

    writeFileSync(
      path,
      JSON.stringify({
        v: 2,
        kdf: "scrypt",
        salt: "YWFhYWFhYWFhYWFhYWFhYQ==",
        nonce: "YWFhYWFhYWFhYWFh",
        ciphertext: "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=",
      }),
      { mode: 0o600 },
    );
    await assert.rejects(
      () => openVault({ path, provider: passphraseKeyProvider(PASS) }),
      /malformed envelope/,
    );
  });
});

describe("GCM AAD binds v2 header", () => {
  it("new writes are v=2 with AAD; tampering any header field fails decrypt", async () => {
    const path = tmpVaultPath();
    const vault = await openVault({
      path,
      provider: passphraseKeyProvider(PASS),
    });
    await vault.set("providers/openai", SECRET);
    const env = readEnvelope(path)!;
    assert.equal(env.v, VAULT_FORMAT_VERSION);
    assert.equal(env.n, SCRYPT_N_CURRENT);

    const headerKeys = ["v", "kdf", "n", "r", "p", "salt", "nonce"] as const;
    for (const field of headerKeys) {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        unknown
      >;
      const tampered = { ...parsed };
      if (field === "v") tampered.v = 1;
      else if (field === "kdf") tampered.kdf = "raw";
      else if (field === "n") tampered.n = SCRYPT_N_LEGACY;
      else if (field === "r") tampered.r = 7;
      else if (field === "p") tampered.p = 2;
      else if (field === "salt" || field === "nonce") {
        const cur = String(parsed[field]);
        tampered[field] = `${cur.slice(0, -1)}${cur.endsWith("A") ? "B" : "A"}`;
      }
      const probe = join(path, "..", `tamper-${field}.enc`);
      writeFileSync(probe, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
      await assert.rejects(
        () => openVault({ path: probe, provider: passphraseKeyProvider(PASS) }),
        /decryption failed|invalid kdf params|malformed envelope|unsupported format|invalid nonce|passphrase required|missing salt/,
        `tamper ${field} must fail closed`,
      );
    }
  });

  it("legacy v=1 (no AAD) still opens via the legacy decrypt path", async () => {
    const path = tmpVaultPath();
    writeLegacyV1ScryptVault(path, PASS, { a: "b" });
    const env = readEnvelope(path)!;
    assert.equal(env.v, VAULT_FORMAT_VERSION_LEGACY);
    const material = await passphraseKeyProvider(PASS).resolve(false);
    const key = resolveFileKey(env, material);
    const payload = decryptPayload(key, env);
    assert.equal(payload.entries.a, "b");
  });

  it("raw-string header byte flip in v2 salt fails decryption", async () => {
    const path = tmpVaultPath();
    const vault = await openVault({
      path,
      provider: passphraseKeyProvider(PASS),
    });
    await vault.set("k", "v");
    const raw = readFileSync(path, "utf8");
    const env = JSON.parse(raw) as { salt: string };
    const idx = raw.indexOf(env.salt);
    assert.ok(idx > 0);
    const flip = env.salt[0] === "A" ? "B" : "A";
    const tampered = `${raw.slice(0, idx)}${flip}${raw.slice(idx + 1)}`;
    writeFileSync(path, tampered, { mode: 0o600 });
    await assert.rejects(
      () => openVault({ path, provider: passphraseKeyProvider(PASS) }),
      /decryption failed|invalid kdf params|malformed envelope/,
    );
  });
});

describe("parseEnvelope rejects prototype keys", () => {
  it('envelope with "__proto__" throws vault: malformed envelope', () => {
    const raw = JSON.parse(
      '{"v":2,"kdf":"raw","nonce":"YQ==","ciphertext":"YQ==","__proto__":{"x":1}}',
    );
    assert.throws(() => parseEnvelope(raw), /vault: malformed envelope/);
  });
});
