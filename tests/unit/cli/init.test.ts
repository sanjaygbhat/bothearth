import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { assertValid, type JsonSchemaLike } from "../../../src/schema/validate.ts";
import { withDefaults } from "../../../src/config/load.ts";
import { runInit } from "../../../src/cli/init.ts";

function loadSchema(): JsonSchemaLike {
  return JSON.parse(
    readFileSync(new URL("../../../modelbot.schema.json", import.meta.url), "utf8"),
  ) as JsonSchemaLike;
}

test("init writes a schema-valid config and 0600 random tokens", async () => {
  const home = mkdtempSync(join(tmpdir(), "mb-init-"));
  const dataDir = join(home, "data");
  process.env.MODELBOT_VAULT_KEY_HEX = Buffer.alloc(32, 7).toString("hex");
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
  const cfgPath = join(home, "modelbot.yaml");
  assert.ok(existsSync(cfgPath));
  const doc = parseYaml(readFileSync(cfgPath, "utf8"));
  assertValid(loadSchema(), doc);

  const tokPath = join(home, "tokens.json");
  assert.ok(existsSync(tokPath));
  const mode = statSync(tokPath).mode & 0o777;
  assert.equal(mode, 0o600);
  const tokens = JSON.parse(readFileSync(tokPath, "utf8")) as {
    mcp_token: string;
    bootstrap_token: string;
  };
  assert.ok(tokens.mcp_token.length >= 32);
  assert.ok(tokens.bootstrap_token.length >= 32);
  assert.notEqual(tokens.mcp_token, tokens.bootstrap_token);
});

// A generated config that pins today's limits freezes them: the owner's
// `~/.modelbot/modelbot.yaml` still said `max_steps: 60` long after the daemon
// default moved to 400, and every task on that install died at step 60.
test("init writes no limit values, so the daemon defaults apply", async () => {
  const home = mkdtempSync(join(tmpdir(), "mb-init-limits-"));
  process.env.MODELBOT_VAULT_KEY_HEX = Buffer.alloc(32, 7).toString("hex");
  await runInit([
    "--home",
    home,
    "--data-dir",
    join(home, "data"),
    "--skip-detect",
    "--skip-images",
    "--quiet",
    "--force",
  ]);
  const text = readFileSync(join(home, "modelbot.yaml"), "utf8");
  const active = text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  for (const key of [
    "max_steps",
    "stall_sec",
    "spend_cap_usd",
    "approval_ttl_sec",
    "ttl_sec",
  ]) {
    assert.ok(
      !new RegExp(`^\\s*${key}\\s*:`, "m").test(active),
      `init must not pin ${key}`,
    );
  }

  const cfg = withDefaults(parseYaml(text)) as {
    agent: { max_steps: number; stall_sec: number; spend_cap_usd: number };
    policy: { approval_ttl_sec: number };
    takeover: { ttl_sec: number };
  };
  assert.equal(cfg.agent.max_steps, 400);
  assert.equal(cfg.agent.stall_sec, 300);
  assert.equal(cfg.policy.approval_ttl_sec, 900);
  assert.equal(cfg.agent.spend_cap_usd, 20);
  assert.equal(cfg.takeover.ttl_sec, 600);
});
