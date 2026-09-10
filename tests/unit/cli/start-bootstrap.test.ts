/**
 * start mints a fresh one-time bootstrap token per composition.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runInit } from "../../../src/cli/init.ts";
import { buildProductionComposition } from "../../../src/cli/start.ts";
import { hashBootstrapToken } from "../../../src/cli/tokens.ts";
import { tokensPath } from "../../../src/cli/paths.ts";

const ENV_KEYS = [
  "MODELBOT_HOME",
  "MODELBOT_CONFIG",
  "MODELBOT_DATA_DIR",
  "MODELBOT_SQLITE_PATH",
  "MODELBOT_MCP_TOKEN",
  "MODELBOT_TOKEN",
  "MODELBOT_BOOTSTRAP_TOKEN",
  "MODELBOT_HOST",
  "MODELBOT_BIND",
  "MODELBOT_PORT",
  "MODELBOT_ALLOW_PUBLIC_BIND",
  "MODELBOT_WORKSPACE_ROOT",
  "MODELBOT_VAULT_KEY_HEX",
  "SSH_CONNECTION",
  "DISPLAY",
  "WAYLAND_DISPLAY",
] as const;

async function withCleanStartEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  try {
    return await fn();
  } finally {
    for (const key of ENV_KEYS) {
      const prev = saved[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }
}

describe("buildProductionComposition bootstrap", () => {
  it("two successive buildProductionComposition calls with the same home return different bootstrap tokens", async () => {
    await withCleanStartEnv(async () => {
      const home = mkdtempSync(join(tmpdir(), "mb-r59-"));
      const dataDir = join(home, "data");
      process.env.MODELBOT_VAULT_KEY_HEX = Buffer.alloc(32, 11).toString("hex");
      await runInit([
        "--home",
        home,
        "--data-dir",
        dataDir,
        "--skip-detect",
        "--skip-images",
        "--quiet",
        "--force",
      ]);
      process.env.DISPLAY = ":synthetic-desktop";
      const first = await buildProductionComposition({ home, port: 0 });
      assert.equal(first.daemon.headless, false);
      process.env.SSH_CONNECTION = "synthetic-ssh-session";
      const second = await buildProductionComposition({ home, port: 0 });
      assert.equal(second.daemon.headless, true);
      assert.notEqual(first.bootstrapToken, second.bootstrapToken);
      assert.ok(first.bootstrapToken.length >= 32);
      assert.ok(second.bootstrapToken.length >= 32);

      const tokPath = tokensPath(home);
      const raw = readFileSync(tokPath, "utf8");
      assert.equal(raw.includes(first.bootstrapToken), false);
      assert.equal(raw.includes(second.bootstrapToken), false);
      const parsed = JSON.parse(raw) as {
        bootstrap_token?: string;
        bootstrap_token_hash?: string;
      };
      assert.equal(parsed.bootstrap_token, undefined);
      assert.equal(parsed.bootstrap_token_hash, hashBootstrapToken(second.bootstrapToken));

      const dataRaw = readFileSync(join(dataDir, "tokens.json"), "utf8");
      assert.equal(dataRaw.includes(first.bootstrapToken), false);
      assert.equal(dataRaw.includes(second.bootstrapToken), false);
    });
  });
});
