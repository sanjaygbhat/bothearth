import { randomBytes } from "node:crypto";
/**
 * Vault guarantees — no Docker.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { AuditLog } from "../../../src/audit/log.ts";
import { logInfo } from "../../../src/daemon/log.ts";
import { EventBus, makeEvent } from "../../../src/daemon/events.ts";
import {
  browserCreateArgs,
  shellCreateArgs,
  proxyCreateArgs,
} from "../../../src/sandbox/flags.ts";
import {
  createVault,
  ensureAuditHmacKey,
  loadConnectorEnv,
  openVault,
  resolveProviderApiKey,
  vaultAuditKeyProvider,
  VAULT_AUDIT_HMAC,
} from "../../../src/vault/index.ts";
import { passphraseKeyProvider, envKeyProvider } from "../../../src/vault/providers.ts";
import { decryptPayload } from "../../../src/vault/crypto.ts";
import { readEnvelope } from "../../../src/vault/file.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../../../src/cli/index.ts");

const CANARY = "sk-canary-SECRET-vault14-NEVER-LEAK";
const PASS = "unit-test-passphrase-vault";
const VAULT_PATH_MARKER = "/Users/tester/ModelBot/vault.enc";

function tmpVaultDir(): string {
  return mkdtempSync(join(tmpdir(), "mb-vault-"));
}

function captureConsole(fn: () => void | Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const log = console.log.bind(console);
  const warn = console.warn.bind(console);
  const error = console.error.bind(console);
  const push = (s: unknown) => {
    chunks.push(typeof s === "string" ? s : String(s));
  };
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    push(chunk);
    return out(chunk as never, ...(rest as never[]));
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    push(chunk);
    return err(chunk as never, ...(rest as never[]));
  }) as typeof process.stderr.write;
  console.log = (...a: unknown[]) => {
    push(a.map(String).join(" "));
    log(...a);
  };
  console.warn = (...a: unknown[]) => {
    push(a.map(String).join(" "));
    warn(...a);
  };
  console.error = (...a: unknown[]) => {
    push(a.map(String).join(" "));
    error(...a);
  };
  return Promise.resolve(fn()).finally(() => {
    process.stdout.write = out;
    process.stderr.write = err;
    console.log = log;
    console.warn = warn;
    console.error = error;
  }).then(() => chunks.join(""));
}

describe("vault v1 crypto + API", () => {
  it("set/get/list/delete/rotate with passphrase; mode 0600", async () => {
    const dir = tmpVaultDir();
    const path = join(dir, "vault.enc");
    const vault = await createVault({
      path,
      keychain: "passphrase",
      passphrase: PASS,
      provider: passphraseKeyProvider(PASS),
    });
    await vault.set("providers/openai", CANARY);
    await vault.set("connectors/gh/TOKEN", "tok-1");
    assert.equal(await vault.get("providers/openai"), CANARY);
    assert.deepEqual(await vault.list(), [
      "connectors/gh/TOKEN",
      "providers/openai",
    ]);
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600);

    await vault.rotate();
    assert.equal(await vault.get("providers/openai"), CANARY);

    await vault.delete("connectors/gh/TOKEN");
    assert.deepEqual(await vault.list(), ["providers/openai"]);
  });

  it("wrong passphrase fails closed; ciphertext hides plaintext", async () => {
    const dir = tmpVaultDir();
    const path = join(dir, "vault.enc");
    const vault = await createVault({
      path,
      provider: passphraseKeyProvider(PASS),
    });
    await vault.set("providers/openai", CANARY);

    const raw = readFileSync(path, "utf8");
    assert.equal(raw.includes(CANARY), false);
    assert.equal(raw.includes(PASS), false);

    await assert.rejects(
      () =>
        openVault({
          path,
          provider: passphraseKeyProvider("wrong-passphrase"),
        }),
      /decryption failed|wrong key/,
    );

    // Corrupt key still fails closed.
    const env = readEnvelope(path)!;
    assert.throws(() => {
      const badKey = Buffer.alloc(32, 7);
      decryptPayload(badKey, env);
    }, /decryption failed/);
  });

  it("env key provider (CI) round-trips", async () => {
    const dir = tmpVaultDir();
    const path = join(dir, "vault.enc");
    const hex = Buffer.alloc(32, 0xab).toString("hex");
    process.env.MODELBOT_VAULT_KEY_HEX = hex;
    try {
      const vault = await createVault({
        path,
        provider: envKeyProvider(),
      });
      await vault.set("audit/hmac", "aabbccdd");
      const again = await openVault({ path, provider: envKeyProvider() });
      assert.equal(await again.get("audit/hmac"), "aabbccdd");
      await again.rotate();
      // rotate mints new master into env via store()
      assert.notEqual(process.env.MODELBOT_VAULT_KEY_HEX, hex);
      assert.equal(await again.get("audit/hmac"), "aabbccdd");
    } finally {
      delete process.env.MODELBOT_VAULT_KEY_HEX;
    }
  });

  it("chmod drift detected by assert on persist", async () => {
    const dir = tmpVaultDir();
    const path = join(dir, "vault.enc");
    const vault = await createVault({
      path,
      provider: passphraseKeyProvider(PASS),
    });
    await vault.set("a", "1");
    chmodSync(path, 0o644);
    // next persist re-applies 0600
    await vault.set("b", "2");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

describe("vault integrate helpers", () => {
  it("resolveProviderApiKey XOR + connector env + audit key", async () => {
    const dir = tmpVaultDir();
    const path = join(dir, "vault.enc");
    const vault = await createVault({
      path,
      provider: passphraseKeyProvider(PASS),
    });
    await vault.set("providers/openai", CANARY);
    await vault.set("connectors/slack/API_TOKEN", "slack-secret");

    const key = await resolveProviderApiKey(
      { model: "gpt", api_key_vault: "providers/openai" },
      vault,
    );
    assert.equal(key, CANARY);

    await assert.rejects(
      () =>
        resolveProviderApiKey(
          {
            model: "gpt",
            api_key_vault: "providers/openai",
            api_key_env: "FOO",
          },
          vault,
        ),
      /mutually exclusive/,
    );

    const env = await loadConnectorEnv(vault, "slack", ["API_TOKEN", "MISSING"]);
    assert.deepEqual(env, { API_TOKEN: "slack-secret" });

    await ensureAuditHmacKey(vault);
    const hmac = await vault.get(VAULT_AUDIT_HMAC);
    assert.ok(hmac && hmac.length === 64);
    const provider = vaultAuditKeyProvider(vault);
    const buf = await provider.getAuditHmacKey();
    assert.equal(buf.toString("hex"), hmac);
  });
});

describe("vault secrets never in logs/audit/events", () => {
  it("grep captured output + audit file for canary", async () => {
    const dir = tmpVaultDir();
    const vaultPath = join(dir, "vault.enc");
    const auditPath = join(dir, "audit.jsonl");

    const vault = await createVault({
      path: vaultPath,
      provider: passphraseKeyProvider(PASS),
    });
    await vault.set("providers/openai", CANARY);
    await ensureAuditHmacKey(vault);
    const hmacHex = (await vault.get(VAULT_AUDIT_HMAC))!;

    const captured = await captureConsole(async () => {
      logInfo("provider configured", {
        name: "providers/openai",
        api_key: CANARY,
        secret: CANARY,
      });
      const bus = new EventBus();
      const seen: string[] = [];
      bus.subscribe((ev) => seen.push(JSON.stringify(ev)));
      bus.emitEvent(
        makeEvent("task.started", {
          vault_entry: "providers/openai",
          // events must not carry secret values
        }),
      );
      assert.equal(seen.join("").includes(CANARY), false);

      const log = new AuditLog({
        path: auditPath,
        keyProvider: vaultAuditKeyProvider(vault),
        anchorEvery: 100,
      });
      await log.append({
        type: "tool.call",
        body: { tool: "done", vault_ref: "providers/openai" },
      });
    });

    assert.equal(captured.includes(CANARY), false, "canary leaked to console");
    assert.equal(captured.includes(hmacHex), false, "hmac key leaked to console");
    assert.ok(captured.includes("[redacted]"));

    const auditRaw = readFileSync(auditPath, "utf8");
    assert.equal(auditRaw.includes(CANARY), false);
    assert.equal(auditRaw.includes(hmacHex), false);
    assert.equal(auditRaw.includes(PASS), false);

    // CLI set/ls/get — no secret-bearing argv; env key + value-file only
    const cliVaultPath = join(dir, "cli-vault.enc");
    const keyHex = randomBytes(32).toString("hex");
    const valueFile = join(dir, "value.txt");
    writeFileSync(valueFile, CANARY, { mode: 0o600 });
    const env = {
      ...process.env,
      MODELBOT_VAULT_KEY_HEX: keyHex,
    };
    const setR = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        cli,
        "vault",
        "set",
        "providers/openai",
        "--path",
        cliVaultPath,
        "--value-file",
        valueFile,
      ],
      { encoding: "utf8", env },
    );
    assert.equal(setR.status, 0, setR.stderr);
    assert.equal(setR.stdout.includes(CANARY), false);
    assert.ok(setR.stdout.includes("set providers/openai"));

    const lsR = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        cli,
        "vault",
        "ls",
        "--path",
        cliVaultPath,
      ],
      { encoding: "utf8", env },
    );
    assert.equal(lsR.status, 0, lsR.stderr);
    assert.equal(lsR.stdout.includes(CANARY), false);
    assert.ok(lsR.stdout.includes("providers/openai"));

    const getR = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        cli,
        "vault",
        "get",
        "providers/openai",
        "--path",
        cliVaultPath,
      ],
      { encoding: "utf8", env },
    );
    assert.equal(getR.status, 0, getR.stderr);
    assert.ok(getR.stdout.includes(CANARY));
  });
});

describe("vault never in sandbox docker argv", () => {
  it("browser/shell/proxy flag builders omit vault path", () => {
    const opts = {
      name: "demo",
      workspaceHost: "/home/user/ModelBot/computers/demo/workspace",
      seccompPath: "/repo/sandbox/seccomp-chromium.json",
    };
    const joined = [
      ...browserCreateArgs(opts),
      ...shellCreateArgs(opts),
      ...proxyCreateArgs(opts),
    ].join("\0");

    assert.equal(joined.includes(VAULT_PATH_MARKER), false);
    assert.equal(joined.includes("vault.enc"), false);
    assert.equal(joined.includes("/ModelBot/vault"), false);
    assert.equal(joined.includes("docker.sock"), false);

    // Only expected bind/volume targets (workspace, profile, optional
    // MODELBOT_TEST_DEV_ROOT source mounts under /opt/computer-server-root).
    const mounts = joined.split("\0").filter((a) => a.startsWith("type="));
    for (const m of mounts) {
      assert.equal(m.includes("vault"), false);
      assert.ok(
        m.includes("target=/workspace") ||
          m.includes("target=/home/browser/profile") ||
          m.includes("target=/opt/computer-server-root/"),
        `unexpected mount: ${m}`,
      );
    }
  });
});

describe("vault wrong-key does not wipe file", () => {
  it("failed open leaves ciphertext intact", async () => {
    const dir = tmpVaultDir();
    const path = join(dir, "vault.enc");
    const vault = await createVault({
      path,
      provider: passphraseKeyProvider(PASS),
    });
    await vault.set("providers/openai", CANARY);
    const before = readFileSync(path);

    await assert.rejects(() =>
      openVault({ path, provider: passphraseKeyProvider("nope") }),
    );
    assert.deepEqual(readFileSync(path), before);

    const ok = await openVault({
      path,
      provider: passphraseKeyProvider(PASS),
    });
    assert.equal(await ok.get("providers/openai"), CANARY);
  });
});
