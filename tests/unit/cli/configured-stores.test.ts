import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RoutinesStore } from "../../../src/scheduler/store.ts";
import { openVault } from "../../../src/vault/index.ts";

test("vault and routine CLI use the configured home and daemon store overrides", async () => {
  const home = mkdtempSync(join(tmpdir(), "modelbot-cli-stores-"));
  const data = join(home, "chosen-data");
  mkdirSync(data);
  const vaultPath = join(data, "chosen-vault.enc");
  writeFileSync(join(home, "modelbot.yaml"), JSON.stringify({ data_dir: data, vault: { path: vaultPath } }));
  const key = Buffer.alloc(32, 13).toString("hex");
  const env: NodeJS.ProcessEnv = { ...process.env, MODELBOT_NO_OPEN: "1", CI: "1", MODELBOT_HOME: home,
    MODELBOT_VAULT_KEY_HEX: key };
  for (const name of ["MODELBOT_CONFIG", "MODELBOT_VAULT_PATH", "MODELBOT_SQLITE_PATH", "MODELBOT_SQLITE", "MODELBOT_DATA_DIR"]) delete env[name];
  const run = (args: string[], extraEnv = {}) => {
    const result = spawnSync(process.execPath, ["--permission", "--allow-fs-read=*", `--allow-fs-write=${home}`,
      new URL("../../../src/cli/index.ts", import.meta.url).pathname, ...args], {
      env: { ...env, ...extraEnv }, encoding: "utf8", input: "release-test-value\n", timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  run(["vault", "set", "providers/test"]);
  assert.equal(existsSync(vaultPath), true);
  const vault = await openVault({ path: vaultPath, provider: {
    kind: "env", resolve: async () => ({ kind: "env", key: Buffer.from(key, "hex") }),
  } });
  assert.equal(await vault.get("providers/test"), "release-test-value");

  const add = ["routine", "add", "--name", "launch-check", "--cron", "0 9 * * *", "--computer", "test", "--goal", "Read the fixture"];
  for (const overrides of [{}, { MODELBOT_SQLITE_PATH: join(data, "override.sqlite") }]) {
    run(add, overrides);
    const store = new RoutinesStore(overrides.MODELBOT_SQLITE_PATH ?? join(data, "modelbot.sqlite"));
    try { assert.equal(store.getByName("launch-check")?.computer_name, "test"); }
    finally { store.close(); }
  }
});
