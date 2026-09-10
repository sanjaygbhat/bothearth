/**
 * Machine-readable startup failure + a `doctor` vault check that really decrypts.
 *
 * The Mac app once offered "Try again" for an undecryptable vault, which could never
 * succeed, because a human log line is all the daemon left behind; `doctor` printed
 * `vault: PASS` for that same vault.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  classifyStartupError,
  EX_CONFIG,
  formatStartupErrorLine,
  STARTUP_ERROR_PREFIX,
} from "../../../src/cli/startup-error.ts";
import {
  checkVaultUnlock,
  runSecurityAudit,
  type SecurityAuditInput,
} from "../../../src/cli/doctor.ts";
import { buildProductionComposition } from "../../../src/cli/start.ts";
import { runInit } from "../../../src/cli/init.ts";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "../../../src/cli/index.ts");
const KEY_A = "a".repeat(64);
const KEY_B = "c".repeat(64);

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "mb-startup-"));
}

/** A fully initialized home whose vault was sealed with `keyHex`. */
async function initHome(keyHex: string): Promise<{ home: string; vaultPath: string }> {
  const home = tmpHome();
  const dataDir = join(home, "data");
  const prev = process.env.MODELBOT_VAULT_KEY_HEX;
  process.env.MODELBOT_VAULT_KEY_HEX = keyHex;
  try {
    await runInit([
      "--home", home,
      "--data-dir", dataDir,
      "--skip-detect", "--skip-images", "--quiet",
    ]);
  } finally {
    if (prev === undefined) delete process.env.MODELBOT_VAULT_KEY_HEX;
    else process.env.MODELBOT_VAULT_KEY_HEX = prev;
  }
  return { home, vaultPath: join(dataDir, "vault.enc") };
}

test("a vault failure names the exact recovery command and asks for a key reset", () => {
  const home = "/Users/x/Library/Application Support/ModelBot";
  const failure = classifyStartupError(
    new Error("vault: decryption failed (wrong key or corrupt file)"),
    home,
  );

  assert.equal(failure.action, "reset_vault_key");
  assert.equal(failure.exitCode, EX_CONFIG);
  assert.equal(EX_CONFIG, 78);
  assert.match(failure.message, /decryption failed/);
  assert.match(
    failure.message,
    /modelbot init --home "\/Users\/x\/Library\/Application Support\/ModelBot" --reset-vault-key/,
  );
});

test("headless key-source failures preserve the vault and never suggest discarding it", () => {
  const unavailable = classifyStartupError(new Error("vault: Secret Service is unavailable."));
  assert.equal(unavailable.action, "none");
  assert.equal(unavailable.exitCode, EX_CONFIG);
  assert.match(unavailable.message, /Restore access/);
  assert.doesNotMatch(unavailable.message, /reset-vault-key/);
  const previous = process.env.CREDENTIALS_DIRECTORY;
  process.env.CREDENTIALS_DIRECTORY = "/run/credentials/modelbot.service";
  try {
    const wrongServiceKey = classifyStartupError(new Error("vault: decryption failed (wrong key or corrupt file)"));
    assert.equal(wrongServiceKey.action, "none");
    assert.doesNotMatch(wrongServiceKey.message, /reset-vault-key/);
  } finally {
    if (previous === undefined) delete process.env.CREDENTIALS_DIRECTORY;
    else process.env.CREDENTIALS_DIRECTORY = previous;
  }
});

test("the line is one line and the cause never swallows the delimiter", () => {
  const failure = classifyStartupError(
    new Error("vault: the stored vault master key is not usable.\n  second line | with a pipe"),
    "/h",
  );
  const line = formatStartupErrorLine(failure);

  assert.ok(line.startsWith(`${STARTUP_ERROR_PREFIX} `));
  assert.equal(line.includes("\n"), false);
  // Exactly one delimiter, so the app can split on the last "|" and get the action back.
  assert.equal(line.split("|").length, 2);
  assert.equal(line.split("|")[1], "reset_vault_key");
});

test("configuration faults route to settings; anything else is a plain failure", async () => {
  // A home that *is* set up, so the uninitialised branch below cannot claim these.
  const { home } = await initHome(KEY_A);

  const cfg = classifyStartupError(new Error("empty MCP token"), home);
  assert.equal(cfg.action, "open_settings");
  assert.equal(cfg.exitCode, EX_CONFIG);
  assert.match(cfg.message, /modelbot\.yaml/);

  const other = classifyStartupError(new Error("EADDRINUSE: address already in use"), home);
  assert.equal(other.action, "none");
  assert.equal(other.exitCode, 1);
});

/**
 * The Mac shell lights a button only for an action name it knows
 * (`reset_vault_key` / `init` / …). An unset-up home must therefore say `init`, never `none`
 * and never `open_settings` — there are no settings to open yet.
 */
test("an unset-up home asks for init, not for settings", () => {
  const empty = tmpHome();
  const failure = classifyStartupError(
    new Error(`ENOENT: no such file or directory, stat '${join(empty, "modelbot.yaml")}'`),
    empty,
  );

  assert.equal(failure.action, "init");
  assert.equal(failure.exitCode, EX_CONFIG);
  assert.match(failure.message, new RegExp(`modelbot init --home "?${empty}"?`));
});

test("start on an unset-up home exits 78 and asks for init", () => {
  const empty = tmpHome();
  let status = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, [cli, "start", "--home", empty, "--port", "0"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { status: number; stderr: string };
    status = e.status;
    stderr = e.stderr;
  }

  assert.equal(status, EX_CONFIG, `stderr:\n${stderr}`);
  const last = stderr.trimEnd().split("\n").at(-1) ?? "";
  assert.ok(last.startsWith(`${STARTUP_ERROR_PREFIX} `), `last stderr line was: ${last}`);
  assert.equal(last.split("|").at(-1), "init");
});

test("start exits 78 with the machine-readable line when the vault will not open", async () => {
  const { home } = await initHome(KEY_A);
  let status = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, [cli, "start", "--home", home, "--port", "0"], {
      encoding: "utf8",
      env: { ...process.env, MODELBOT_VAULT_KEY_HEX: KEY_B },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { status: number; stderr: string };
    status = e.status;
    stderr = e.stderr;
  }

  assert.equal(status, EX_CONFIG, `expected EX_CONFIG, stderr:\n${stderr}`);
  const lines = stderr.trimEnd().split("\n");
  const last = lines[lines.length - 1] ?? "";
  assert.ok(last.startsWith(`${STARTUP_ERROR_PREFIX} `), `last stderr line was: ${last}`);
  assert.equal(last.split("|").at(-1), "reset_vault_key");
  // The human log is still there, above it — this line adds to the log, it does not replace it.
  assert.ok(lines.length > 1 && lines.slice(0, -1).join("\n").includes("start failed"));
});

test("doctor's vault check decrypts, and fails with the same recovery text", async () => {
  const { home, vaultPath } = await initHome(KEY_A);
  const prev = process.env.MODELBOT_VAULT_KEY_HEX;

  try {
    process.env.MODELBOT_VAULT_KEY_HEX = KEY_A;
    const ok = await checkVaultUnlock(vaultPath, "auto", home);
    assert.equal(ok.ok, true, ok.detail);
    assert.match(ok.detail, /unlocked/);

    process.env.MODELBOT_VAULT_KEY_HEX = KEY_B;
    const bad = await checkVaultUnlock(vaultPath, "auto", home);
    assert.equal(bad.ok, false);
    assert.equal(bad.action, "reset_vault_key");
    assert.match(bad.detail, /--reset-vault-key/);
  } finally {
    if (prev === undefined) delete process.env.MODELBOT_VAULT_KEY_HEX;
    else process.env.MODELBOT_VAULT_KEY_HEX = prev;
  }
});

test("first startup creates a signed audit anchor and never repairs a truncated log silently", async () => {
  const { home } = await initHome(KEY_A);
  const previous = process.env.MODELBOT_VAULT_KEY_HEX;
  process.env.MODELBOT_VAULT_KEY_HEX = KEY_A;
  try {
    const composition = await buildProductionComposition({ home, port: 0 });
    const log = composition.daemon.auditLog!;
    assert.equal(log.head().seq, 1);
    assert.equal(JSON.parse(readFileSync(log.path, "utf8")).type, "audit.anchor");
    const doctor = () => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval",
      `import { runDoctorCli } from ${JSON.stringify(new URL("../../../src/cli/doctor.ts", import.meta.url).href)}; process.exit(await runDoctorCli(["--json"], { home: ${JSON.stringify(home)}, containers: [] }));`,
    ], {
      encoding: "utf8", env: process.env,
    }));
    assert.equal(doctor().checks.find((row: { id: string }) => row.id === "audit_chain").severity, "PASS");
    assert.equal((await buildProductionComposition({ home, port: 0 })).daemon.auditLog!.head().seq, 1);
    writeFileSync(log.path, "");
    await buildProductionComposition({ home, port: 0 });
    assert.throws(doctor, (err: unknown) => {
      const report = JSON.parse((err as { stdout: string }).stdout);
      assert.match(report.checks.find((row: { id: string }) => row.id === "audit_chain").detail, /truncated/);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.MODELBOT_VAULT_KEY_HEX;
    else process.env.MODELBOT_VAULT_KEY_HEX = previous;
  }
});

test("an existing but unopenable vault is FAIL, not the old existence-only PASS", () => {
  const base: SecurityAuditInput = {
    bind: "127.0.0.1",
    port: 7777,
    mcpTokenPresent: true,
    bootstrapTokenPresent: true,
    vaultMode: "auto",
    vaultPath: "/h/data/vault.enc",
    images: [],
    containers: [],
    proxyDenylistActive: true,
    auditChain: { ok: true, detail: "n/a" },
  };

  const broken = runSecurityAudit({
    ...base,
    vaultUnlock: { ok: false, detail: "could not unlock", action: "reset_vault_key" },
  }).find((c) => c.id === "vault");
  assert.equal(broken?.severity, "FAIL");
  assert.equal(broken?.action, "reset_vault_key");

  const good = runSecurityAudit({
    ...base,
    vaultUnlock: { ok: true, detail: "auto unlocked 1 entries" },
  }).find((c) => c.id === "vault");
  assert.equal(good?.severity, "PASS");
  assert.match(good?.detail ?? "", /unlocked/);
});

test("doctor --json reports the vault failure and its recovery action", async () => {
  const { home } = await initHome(KEY_A);
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, [cli, "doctor", "--home", home, "--json"], {
      encoding: "utf8",
      env: { ...process.env, MODELBOT_VAULT_KEY_HEX: KEY_B },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // doctor exits nonzero on any FAIL, which is exactly what this asserts.
    stdout = (err as { stdout: string }).stdout;
  }

  const report = JSON.parse(stdout) as {
    result: string;
    checks: Array<{ id: string; severity: string; action?: string }>;
  };
  const vault = report.checks.find((c) => c.id === "vault");
  assert.equal(report.result, "FAIL");
  assert.equal(vault?.severity, "FAIL");
  assert.equal(vault?.action, "reset_vault_key");
});

/**
 * `policy.approval_ttl_sec` reaches `DaemonOptions` only through the mapping in start.ts.
 * Without that one line the key is inert: editing it changes nothing and the dispatcher
 * silently keeps its own default.
 */
test("the configured approval TTL reaches the daemon options", async () => {
  const { home } = await initHome(KEY_A);
  const cfgFile = join(home, "modelbot.yaml");
  writeFileSync(cfgFile, `${readFileSync(cfgFile, "utf8")}policy:\n  approval_ttl_sec: 45\n`, {
    mode: 0o600,
  });

  const prev = process.env.MODELBOT_VAULT_KEY_HEX;
  process.env.MODELBOT_VAULT_KEY_HEX = KEY_A;
  try {
    const composition = await buildProductionComposition({ home, port: 0 });
    assert.equal(composition.config.policy.approval_ttl_sec, 45);
    assert.equal(composition.daemon.approvalTtlSec, 45, "config value never reached the daemon");
  } finally {
    if (prev === undefined) delete process.env.MODELBOT_VAULT_KEY_HEX;
    else process.env.MODELBOT_VAULT_KEY_HEX = prev;
  }
});
