import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { withDefaults, writePolicyGates } from "../../../src/config/load.ts";

test("a __proto__ key inside a section cannot reach the merged document", () => {
  // A top-level `__proto__` is already refused by name, so this is the
  // case that actually reaches deepMerge: a nested key inside a real section.
  const merged = withDefaults(
    JSON.parse('{"policy": {"__proto__": {"polluted": true}, "mode": "supervised"}, "data_dir": "~/X"}'),
  ) as Record<string, Record<string, unknown>>;
  assert.equal((merged.policy as { polluted?: unknown }).polluted, undefined);
  assert.equal(({} as { polluted?: unknown }).polluted, undefined, "Object.prototype is untouched");
  assert.equal(merged.policy.mode, "supervised", "the real keys still merge");
  assert.equal(merged.data_dir, "~/X");
});

test("a mistyped section is named, not silently replaced by defaults", () => {
  assert.throws(() => withDefaults({ polciy: { mode: "yolo" } }), (e: Error) => {
    assert.match(e.message, /"polciy"/);
    assert.match(e.message, /policy/, "the message lists the sections that do exist");
    return true;
  });
  assert.doesNotThrow(() => withDefaults({ policy: { mode: "supervised" } }));
});

test("a configured spend cap is its own ceiling until a maximum is named", () => {
  type Agent = { agent: { spend_cap_usd: number; spend_cap_max_usd: number } };
  // The operator wrote one number. Filling the other from the built-in $100
  // would let any request raise their $2 task to fifty times what they set,
  // and `budget_kind: provider_estimate` is real money.
  const capped = withDefaults({ agent: { spend_cap_usd: 2 } }) as Agent;
  assert.equal(capped.agent.spend_cap_usd, 2);
  assert.equal(capped.agent.spend_cap_max_usd, 2);

  // Both named: the operator meant the range they wrote.
  const range = withDefaults({ agent: { spend_cap_usd: 2, spend_cap_max_usd: 40 } }) as Agent;
  assert.equal(range.agent.spend_cap_max_usd, 40);

  // Nothing named: the shipped defaults, unchanged.
  const plain = withDefaults({}) as Agent;
  assert.equal(plain.agent.spend_cap_usd, 0);
  assert.equal(plain.agent.spend_cap_max_usd, 0);
});

test("omitted policy.gates is an empty list, not the six optional classes", () => {
  const empty = withDefaults({}) as { policy: { gates: string[] } };
  assert.deepEqual(empty.policy.gates, []);
  const explicit = withDefaults({ policy: { gates: ["payment"] } }) as { policy: { gates: string[] } };
  assert.deepEqual(explicit.policy.gates, ["payment"]);
});

test("writePolicyGates writes only the keys in the patch", () => {
  const dir = mkdtempSync(join(tmpdir(), "mb-policy-write-"));
  const path = join(dir, "modelbot.yaml");
  writeFileSync(path, "version: 1\nbind: 127.0.0.1\nmode: strict\n", { mode: 0o600 });
  writePolicyGates(path, { gates: ["payment", "upload"], max_steps: 12, spend_cap_usd: 5 });
  const doc = parseYaml(readFileSync(path, "utf8")) as {
    version: number;
    bind: string;
    mode: string;
    policy: { gates: string[] };
    agent: { max_steps: number; spend_cap_usd: number };
  };
  assert.equal(doc.version, 1);
  assert.equal(doc.bind, "127.0.0.1");
  assert.equal(doc.mode, "strict");
  assert.deepEqual(doc.policy.gates, ["payment", "upload"]);
  assert.equal(doc.agent.max_steps, 12);
  assert.equal(doc.agent.spend_cap_usd, 5);
  assert.equal("spend_cap_max_usd" in doc.agent, false);

  writePolicyGates(path, { spend_cap_usd: 0 });
  const again = parseYaml(readFileSync(path, "utf8")) as {
    policy: { gates: string[] };
    agent: { max_steps: number; spend_cap_usd: number };
  };
  assert.deepEqual(again.policy.gates, ["payment", "upload"]);
  assert.equal(again.agent.max_steps, 12);
  assert.equal(again.agent.spend_cap_usd, 0);
});
