import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { assertValid, validateSchema } from "../../../src/schema/validate.ts";
import { TOOL_CATALOGUE } from "../../../src/tools/catalog.ts";

const TAKEOVER_DESCRIPTION =
  "Hands the person the keyboard and mouse of the bot's computer and waits until they give it back.";

const fixtures = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../contracts/tool-fixtures.json"),
    "utf8",
  ),
) as { request_takeover: { example: Record<string, unknown>; bad: Record<string, unknown> } };

describe("request_takeover tool schema", () => {
  const entry = TOOL_CATALOGUE.find((t) => t.name === "request_takeover");
  assert.ok(entry);
  const schema = entry.inputSchema;

  it("describes a handoff, not a when-taxonomy", () => {
    assert.equal(entry.description, TAKEOVER_DESCRIPTION);
    assert.equal(schema.description, TAKEOVER_DESCRIPTION);
    assert.equal(schema.properties?.category, undefined);
    assert.equal(schema.properties?.message, undefined);
    assert.deepEqual(schema.required, []);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties?.reason?.type, "string");
  });

  it("validates with and without reason", () => {
    assertValid(schema, {});
    assertValid(schema, { reason: "The person can type here." });
    assert.ok(validateSchema(schema, { reason: 1 }).length > 0);
    assert.ok(validateSchema(schema, { category: "password" }).length > 0);
    assert.ok(validateSchema(schema, { message: "login form" }).length > 0);
  });

  it("schema-valid free text is the reason consumers already display", () => {
    const args: Record<string, unknown> = { reason: "login form" };
    assertValid(schema, args);
    assert.equal(String(args.reason ?? "model"), "login form");
  });

  it("catalogue fixture example is schema-valid", () => {
    assertValid(schema, fixtures.request_takeover.example);
    assert.ok(validateSchema(schema, fixtures.request_takeover.bad).length > 0);
    assert.equal("category" in fixtures.request_takeover.example, false);
    assert.equal(typeof fixtures.request_takeover.example.reason, "string");
  });
});

describe("browser_navigate tool schema", () => {
  it("does not tell the model to request control", () => {
    const entry = TOOL_CATALOGUE.find((t) => t.name === "browser_navigate");
    assert.ok(entry);
    assert.equal(entry.description.includes("request control"), false);
    assert.match(entry.description, /so the model can snapshot instead of retrying/);
  });
});
