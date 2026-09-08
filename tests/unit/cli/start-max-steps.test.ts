/**
 * `agent.max_steps` has to survive the trip from modelbot.yaml into the daemon
 * options; while it did not, every task ran on the built-in default instead.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runInit } from "../../../src/cli/init.ts";
import { buildProductionComposition } from "../../../src/cli/start.ts";
import { configPath } from "../../../src/cli/paths.ts";

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

describe("buildProductionComposition agent.max_steps", () => {
  it("hands the configured step budget to the daemon", async () => {
    await withCleanStartEnv(async () => {
      const home = mkdtempSync(join(tmpdir(), "mb-steps-"));
      process.env.MODELBOT_VAULT_KEY_HEX = Buffer.alloc(32, 7).toString("hex");
      await runInit([
        "--home", home,
        "--data-dir", join(home, "data"),
        "--skip-detect", "--skip-images", "--quiet", "--force",
      ]);

      const shipped = await buildProductionComposition({ home, port: 0 });
      assert.equal(shipped.daemon.maxSteps, shipped.config.agent.max_steps);

      // init pins no limits, so a fresh install runs on the daemon default and
      // picks up any later change to it.
      assert.equal(shipped.config.agent.max_steps, 400);

      const cfg = configPath(home);
      const raw = readFileSync(cfg, "utf8");
      writeFileSync(cfg, `${raw}agent:\n  max_steps: 123\n`);

      const edited = await buildProductionComposition({ home, port: 0 });
      assert.equal(edited.config.agent.max_steps, 123);
      assert.equal(edited.daemon.maxSteps, 123);
    });
  });
});
