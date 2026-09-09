import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, chmod, symlink, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemdCredentialProvider } from "../../../src/vault/providers.ts";
import { createVault, openVault } from "../../../src/vault/vault.ts";

test("service credential unlocks the same vault after restart and cannot silently rotate away from its key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "modelbot-systemd-key-"));
  const path = join(dir, "vault.enc"), credential = join(dir, "modelbot-vault");
  try {
    await writeFile(credential, "42".repeat(32), { mode: 0o600 });
    const provider = systemdCredentialProvider(dir);
    const vault = await createVault({ path, provider });
    await vault.set("synthetic", "private-canary");
    const restarted = await openVault({ path, provider: systemdCredentialProvider(dir) });
    assert.equal(await restarted.get("synthetic"), "private-canary");
    assert.ok(!(await readFile(path, "utf8")).includes("private-canary"));
    await assert.rejects(restarted.rotate(), /rotate the encrypted systemd credential/);
    assert.equal(await (await openVault({ path, provider })).get("synthetic"), "private-canary");
    await chmod(credential, 0o644);
    await assert.rejects(provider.resolve(false), /permissions or size/);
    await chmod(credential, 0o600);
    await writeFile(credential, "43".repeat(32));
    await assert.rejects(openVault({ path, provider }), /auth|decrypt|authenticate/i);
    await rm(credential); await symlink(path, credential);
    await assert.rejects(provider.resolve(false), /ELOOP|symbolic/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("production init and daemon reopen use the protected service credential without an env master key", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const dir = await mkdtemp(join(tmpdir(), "modelbot-systemd-start-"));
  try {
    await writeFile(join(dir, "modelbot-vault"), "52".repeat(32), { mode: 0o600 });
    const code = `
      import {runInit} from './src/cli/init.ts';
      import {buildProductionComposition} from './src/cli/start.ts';
      import {startDaemon} from './src/daemon/server.ts';
      import {runPairCli} from './src/cli/pair.ts';
      import assert from 'node:assert/strict';
      await runInit(['--home',process.env.HOME,'--data-dir',process.env.HOME+'/data','--skip-detect','--skip-images','--quiet']);
      for(let i=0;i<2;i++) {
        const composition=await buildProductionComposition({home:process.env.HOME,port:0});
        const daemon=await startDaemon(composition.daemon);
        assert.equal((await fetch(daemon.baseUrl+'/healthz')).status,200);
        runPairCli(['--home',process.env.HOME]);
        assert.ok(daemon.store.db.prepare('SELECT COUNT(*) AS n FROM bootstrap_tokens').get().n>=1);
        await daemon.close();
      }
    `;
    await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], { timeout: 30000,
      env: { PATH: process.env.PATH, HOME: dir, CREDENTIALS_DIRECTORY: dir, MODELBOT_TEST_FAKE_COMPUTER: "1" } });
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test("root-managed systemd credential ACL layout accepts read-only files but rejects shared or writable substitutes", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "modelbot-root-credential-"));
  const file = join(dir, "modelbot-vault");
  try {
    await writeFile(file, "42".repeat(32), { mode: 0o440 });
    await chmod(dir, 0o550);
    const provider = systemdCredentialProvider(dir);
    assert.equal((await provider.resolve(false)).key.toString("hex"), "42".repeat(32));
    for (const mode of [0o444, 0o640, 0o460]) {
      await chmod(file, mode);
      await assert.rejects(provider.resolve(false), /permissions or size/);
    }
    await chmod(file, 0o440);
    await chmod(dir, 0o570);
    await assert.rejects(provider.resolve(false), /permissions or size/);
  } finally {
    await chmod(dir, 0o700);
    await rm(dir, { recursive: true, force: true });
  }
});
