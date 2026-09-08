import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadModelbotYamlFile, withDefaults } from "../../../src/config/load.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

type Filled = {
  policy: { approval_ttl_sec: number };
  agent: {
    max_steps: number;
    stall_sec: number;
    loop_identical: number;
    spend_cap_usd: number;
    spend_cap_max_usd: number;
  };
};

// A 20-40 minute task must not die because nobody answered an approval card in
// two minutes, or because the model took more than 60 steps.
test("a zero-config install can run a long task", () => {
  const cfg = withDefaults({}) as Filled;
  assert.equal(cfg.policy.approval_ttl_sec, 900);
  assert.equal(cfg.agent.max_steps, 400);
  assert.equal(cfg.agent.stall_sec, 300);
  assert.equal(cfg.agent.loop_identical, 3);
  // At the $0.01-per-call proxy rate a browser task spends most of its calls
  // reading: $2 bought 200 calls and died mid-job on both attempts.
  assert.equal(cfg.agent.spend_cap_usd, 20);
  assert.equal(cfg.agent.spend_cap_max_usd, 100);
});

test("modelbot.yaml still overrides every long-task default", () => {
  const cfg = withDefaults({
    policy: { approval_ttl_sec: 30 },
    agent: { max_steps: 10, stall_sec: 15 },
  }) as Filled;
  assert.equal(cfg.policy.approval_ttl_sec, 30);
  assert.equal(cfg.agent.max_steps, 10);
  assert.equal(cfg.agent.stall_sec, 15);
  assert.equal(cfg.agent.loop_identical, 3);
});

test("the shipped example.yaml states the same defaults", () => {
  const example = loadModelbotYamlFile(join(root, "src/config/example.yaml")) as Filled;
  assert.equal(example.policy.approval_ttl_sec, 900);
  assert.equal(example.agent.max_steps, 400);
  assert.equal(example.agent.stall_sec, 300);
  assert.equal(example.agent.spend_cap_usd, 20);
  assert.equal(example.agent.spend_cap_max_usd, 100);
});
