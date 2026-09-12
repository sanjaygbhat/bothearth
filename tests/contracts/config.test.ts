import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CONFIG_VERSION,
  loadModelbotYamlFile,
  validateModelbotConfig,
  withDefaults,
} from "../../src/config/load.ts";
import type { JsonSchemaLike } from "../../src/schema/validate.ts";
import { OPTIONAL_POLICY_GATES } from "../../src/types/contracts.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function loadSchema(): JsonSchemaLike {
  return JSON.parse(
    readFileSync(join(root, "modelbot.schema.json"), "utf8"),
  ) as JsonSchemaLike;
}

describe("modelbot.yaml schema", () => {
  it("loads the enterprise pilot flavour without changing defaults", () => {
    const path = join(root, "src/config/enterprise.yaml");
    const rawText = readFileSync(path, "utf8");
    assert.match(rawText, /not default/);
    assert.match(rawText, /no spend cap\./);
    assert.match(rawText, /\$MODELBOT_HOME\/modelbot\.yaml/);
    assert.match(rawText, /Do not `cp` over the active file/);
    assert.match(rawText, /non-empty `policy\.strict_allowlist`/);
    assert.match(rawText, /not loaded/);
    assert.doesNotMatch(rawText, /^\s*strict_allowlist\s*:/m);
    assert.doesNotMatch(rawText, /^\s*spend_cap_usd\s*:/m);
    assert.doesNotMatch(rawText, /^\s*max_steps\s*:/m);

    const doc = loadModelbotYamlFile(path) as Record<string, unknown>;
    const encoded = JSON.stringify(doc);
    assert.equal(encoded.includes("spend_cap_usd"), false);
    assert.equal(encoded.includes("max_steps"), false);

    const cfg = validateModelbotConfig(doc, loadSchema());
    assert.equal(cfg.mode, "strict");
    assert.equal(cfg.sandbox.max_computers, 5);
    assert.deepEqual(cfg.policy.gates, [...OPTIONAL_POLICY_GATES]);
    assert.equal(cfg.agent.spend_cap_usd, 0);
    assert.equal(cfg.agent.max_steps, 0);
    assert.deepEqual(cfg.policy.strict_allowlist, []);

    const defaults = withDefaults({}) as {
      policy: { gates: string[] };
      agent: { spend_cap_usd: number; max_steps: number };
      mode: string;
      sandbox: { max_computers: number };
    };
    assert.deepEqual(defaults.policy.gates, []);
    assert.equal(defaults.agent.spend_cap_usd, 0);
    assert.equal(defaults.agent.max_steps, 0);
    assert.equal(defaults.mode, "supervised");
    assert.equal(defaults.sandbox.max_computers, 2);

    const configMd = readFileSync(join(root, "docs/CONFIG.md"), "utf8");
    assert.match(configMd, /omits `policy\.gates` and spend-cap keys/);
    assert.doesNotMatch(configMd, /still writes empty `policy\.gates`/);
    assert.doesNotMatch(
      configMd,
      /```bash\ncp src\/config\/enterprise\.yaml "\$MODELBOT_HOME\/enterprise\.yaml"/,
    );
    assert.match(configMd, /```yaml\nmode: strict/);
    assert.match(configMd, /non-empty `policy\.strict_allowlist`/);
    assert.match(configMd, /non-loaded reference/);
  });

  it("validates ARCH §3 example.yaml", () => {
    const schema = JSON.parse(
      readFileSync(join(root, "modelbot.schema.json"), "utf8"),
    ) as JsonSchemaLike;
    const doc = loadModelbotYamlFile(join(root, "src/config/example.yaml"));
    const cfg = validateModelbotConfig(doc, schema);
    assert.equal(cfg.version, 1);
    assert.equal(cfg.port, 7777);
    assert.equal(cfg.bind, "127.0.0.1");
    assert.equal(cfg.mode, "supervised");
    assert.equal(cfg.agent.max_steps, 0);
    assert.equal(cfg.agent.spend_cap_usd, 0);
    assert.equal(cfg.agent.spend_cap_max_usd, 0);
    assert.equal(cfg.adapters.default, "openai_compat");
    assert.deepEqual(cfg.scheduler.routines, []);
  });

  it("rejects unknown top-level key", () => {
    const schema = JSON.parse(
      readFileSync(join(root, "modelbot.schema.json"), "utf8"),
    ) as JsonSchemaLike;
    const doc = loadModelbotYamlFile(join(root, "src/config/example.yaml")) as Record<
      string,
      unknown
    >;
    doc.extra = true;
    assert.throws(() => validateModelbotConfig(doc, schema));
  });

  it("accepts an empty config and fills every section", () => {
    const cfg = validateModelbotConfig({}, loadSchema());
    // Zero-config install: same daemon the 88-line example.yaml describes.
    assert.equal(cfg.version, 1);
    assert.equal(cfg.bind, "127.0.0.1");
    assert.equal(cfg.port, 7777);
    assert.equal(cfg.mode, "supervised");
    assert.equal(cfg.policy.kill_switch, false);
    assert.deepEqual(cfg.policy.gates, []);
    assert.equal(cfg.agent.max_steps, 0);
    assert.equal(cfg.agent.spend_cap_usd, 0);
    assert.equal(cfg.agent.spend_cap_max_usd, 0);
    assert.equal(cfg.adapters.default, "openai_compat");
    assert.equal(cfg.sandbox.workspace_root, "~/ModelBot/computers");
    assert.equal(cfg.vault.path, "~/ModelBot/vault.enc");
    assert.equal(cfg.audit.path, "~/ModelBot/audit.jsonl");
  });

  it("gives a task no time limit unless the owner sets one", () => {
    // A hidden 30-minute runner deadline failed a task with its budget and its
    // steps unspent. The only clock left is this one, and it is off.
    const cfg = validateModelbotConfig({}, loadSchema());
    assert.equal(cfg.agent.max_runtime_sec, 0);
    assert.equal(validateModelbotConfig({ agent: { max_runtime_sec: 5400 } }, loadSchema()).agent.max_runtime_sec, 5400);
    assert.throws(() => validateModelbotConfig({ agent: { max_runtime_sec: -1 } }, loadSchema()));
    assert.throws(() => validateModelbotConfig({ agent: { max_runtime_sec: 1.5 } }, loadSchema()));
  });

  it("merges a partial section without dropping its other keys", () => {
    const cfg = validateModelbotConfig({ agent: { spend_cap_usd: 5 } }, loadSchema());
    assert.equal(cfg.agent.spend_cap_usd, 5);
    assert.equal(cfg.agent.max_steps, 0);
    assert.equal(cfg.agent.compact_at, 0.6);
  });

  it("derives workspace, audit and vault paths from data_dir", () => {
    const cfg = validateModelbotConfig({ data_dir: "/srv/mb" }, loadSchema());
    assert.equal(cfg.sandbox.workspace_root, "/srv/mb/computers");
    assert.equal(cfg.audit.path, "/srv/mb/audit.jsonl");
    assert.equal(cfg.vault.path, "/srv/mb/vault.enc");
  });

  it("leaves an explicit value alone", () => {
    const cfg = validateModelbotConfig(
      { bind: "0.0.0.0", mode: "strict", policy: { gates: ["payment"] } },
      loadSchema(),
    );
    assert.equal(cfg.bind, "0.0.0.0");
    assert.equal(cfg.mode, "strict");
    assert.deepEqual(cfg.policy.gates, ["payment"]);
    assert.equal(cfg.policy.kill_switch, false);
    assert.equal(
      validateModelbotConfig(
        { config_version: CONFIG_VERSION, policy: { kill_switch: true } },
        loadSchema(),
      ).policy.kill_switch,
      true,
    );
    assert.equal(
      validateModelbotConfig({ policy: { kill_switch: true } }, loadSchema()).policy.kill_switch,
      false,
    );
  });

  it("validates a third-party adapter block and rejects a malformed one", () => {
    const cfg = validateModelbotConfig(
      { adapters: { default: "gemini", gemini: { model: "gemini-3-pro" } } },
      loadSchema(),
    );
    assert.equal(cfg.adapters.default, "gemini");
    assert.throws(() =>
      validateModelbotConfig({ adapters: { gemini: { model: 7 } } }, loadSchema()),
    );
  });

  it("applying defaults twice changes nothing", () => {
    const once = withDefaults({ port: 8080 });
    assert.deepEqual(withDefaults(once), once);
  });

  it("defaults fill every section and field the schema declares", () => {
    // The schema no longer marks section fields `required` (a partial section is
    // valid on its own), so this is what guarantees the merged config is complete.
    const schema = loadSchema() as unknown as {
      properties: Record<string, { properties?: Record<string, unknown> }>;
    };
    const OPTIONAL = new Set(["remote.allowed_hosts", "remote.public_origin"]);
    const filled = withDefaults({}) as Record<string, Record<string, unknown>>;
    for (const [section, spec] of Object.entries(schema.properties)) {
      if (section === "config_version") continue;
      assert.ok(section in filled, `missing default for ${section}`);
      for (const key of Object.keys(spec.properties ?? {})) {
        // Genuinely optional in ModelbotConfig: absent means "no restriction"
        // and "no reverse proxy", which a default value could not express.
        if (OPTIONAL.has(`${section}.${key}`)) continue;
        assert.ok(
          filled[section]! [key] !== undefined,
          `missing default for ${section}.${key}`,
        );
      }
    }
  });
});
