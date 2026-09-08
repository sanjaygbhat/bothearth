import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { AuditLog } from "../../../src/audit/log.ts";
import { staticAuditKey } from "../../../src/audit/key.ts";
import { resolveAuditVerifyKey } from "../../../src/cli/audit-key.ts";
import {
  createVault,
  ensureAuditHmacKey,
  vaultAuditKeyProvider,
} from "../../../src/vault/index.ts";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../../../src/cli/index.ts");

describe("audit verify key resolution", () => {
  it("prefers --key-file over env and vault", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-ak-"));
    const keyPath = join(dir, "k");
    writeFileSync(keyPath, Buffer.from("file-key"));
    const buf = await resolveAuditVerifyKey(
      { "key-file": keyPath },
      { MODELBOT_AUDIT_KEY_HEX: "aa", MODELBOT_AUDIT_KEY: "env" },
    );
    assert.equal(buf.toString(), "file-key");
  });

  it("uses MODELBOT_AUDIT_KEY_HEX when no --key-file", async () => {
    const buf = await resolveAuditVerifyKey({}, { MODELBOT_AUDIT_KEY_HEX: "616263" });
    assert.equal(buf.toString("hex"), "616263");
  });

  it("loads vault audit/hmac by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-akv-"));
    const vaultPath = join(dir, "vault.enc");
    const cfgPath = join(dir, "modelbot.yaml");
    const hex = Buffer.alloc(32, 9).toString("hex");
    const prev = process.env.MODELBOT_VAULT_KEY_HEX;
    process.env.MODELBOT_VAULT_KEY_HEX = hex;
    try {
      const vault = await createVault({ path: vaultPath, keychain: "auto" });
      await ensureAuditHmacKey(vault);
      const expected = await vaultAuditKeyProvider(vault).getAuditHmacKey();
      writeFileSync(
        cfgPath,
        `vault:\n  path: ${vaultPath}\n  keychain: auto\n`,
        { mode: 0o600 },
      );
      const buf = await resolveAuditVerifyKey({ config: cfgPath }, {});
      assert.deepEqual(buf, expected);
    } finally {
      if (prev === undefined) delete process.env.MODELBOT_VAULT_KEY_HEX;
      else process.env.MODELBOT_VAULT_KEY_HEX = prev;
    }
  });

  it("CLI vault path verifies without --key-file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-akc-"));
    const vaultPath = join(dir, "vault.enc");
    const auditPath = join(dir, "audit.jsonl");
    const cfgPath = join(dir, "modelbot.yaml");
    const hex = Buffer.alloc(32, 3).toString("hex");
    const prev = process.env.MODELBOT_VAULT_KEY_HEX;
    process.env.MODELBOT_VAULT_KEY_HEX = hex;
    try {
      const vault = await createVault({ path: vaultPath, keychain: "auto" });
      await ensureAuditHmacKey(vault);
      const key = await vaultAuditKeyProvider(vault).getAuditHmacKey();
      const log = new AuditLog({ path: auditPath, keyProvider: staticAuditKey(key) });
      await log.append({ type: "task.started", body: {} });
      writeFileSync(
        cfgPath,
        `vault:\n  path: ${vaultPath}\n  keychain: auto\n`,
        { mode: 0o600 },
      );
      const ok = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          cli,
          "audit",
          "verify",
          "--path",
          auditPath,
          "--config",
          cfgPath,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            MODELBOT_VAULT_KEY_HEX: hex,
            MODELBOT_AUDIT_KEY_HEX: "",
            MODELBOT_AUDIT_KEY: "",
          },
        },
      );
      assert.equal(ok.status, 0, ok.stderr + ok.stdout);
    } finally {
      if (prev === undefined) delete process.env.MODELBOT_VAULT_KEY_HEX;
      else process.env.MODELBOT_VAULT_KEY_HEX = prev;
    }
  });
});
