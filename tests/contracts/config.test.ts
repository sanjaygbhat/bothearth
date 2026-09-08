import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadModelbotYamlFile,
  validateModelbotConfig,
  withDefaults,
} from "../../src/config/load.ts";
import type { JsonSchemaLike } from "../../src/schema/validate.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function loadSchema(): JsonSchemaLike {
  return JSON.parse(
    readFileSync(join(root, "modelbot.schema.json"), "utf8"),
  ) as JsonSchemaLike;
}

describe("modelbot.yaml schema", () => {
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
    assert.equal(cfg.agent.max_steps, 400);
    assert.equal(cfg.agent.spend_cap_usd, 20);
    assert.equal(cfg.agent.spend_cap_max_usd, 100);
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
    assert.equal(cfg.policy.kill_switch, true);
    assert.equal(cfg.policy.gates.length, 6);
    assert.equal(cfg.agent.max_steps, 400);
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
    assert.equal(cfg.agent.max_steps, 400);
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
    assert.equal(cfg.policy.kill_switch, true);
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
