import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { TOOL_CATALOGUE, TOOL_META } from "../../src/tools/catalog.ts";
import { TOOL_NAMES, type ToolName } from "../../src/types/contracts.ts";
import { assertValid, validateSchema } from "../../src/schema/validate.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = JSON.parse(
  readFileSync(join(root, "tests/contracts/tool-fixtures.json"), "utf8"),
) as Record<
  ToolName,
  {
    sideEffect: string;
    driver: string;
    example: Record<string, unknown>;
    bad: Record<string, unknown>;
  }
>;

describe("tool catalogue vs ARCH §4", () => {
  it("lists every canonical tool once in order", () => {
    assert.deepEqual(
      TOOL_CATALOGUE.map((t) => t.name),
      [...TOOL_NAMES],
    );
    assert.equal(TOOL_CATALOGUE.length, 25);
  });

  it("has schema + documented sideEffect/driver for each tool", () => {
    for (const name of TOOL_NAMES) {
      const entry = TOOL_CATALOGUE.find((t) => t.name === name);
      assert.ok(entry, name);
      const fix = fixtures[name];
      assert.ok(fix, `fixture ${name}`);
      assert.equal(entry!.sideEffect, fix.sideEffect, name);
      assert.equal(entry!.driver, fix.driver, name);
      assert.equal(TOOL_META[name].sideEffect, fix.sideEffect);
      assert.equal(TOOL_META[name].driver, fix.driver);
      assert.equal(entry!.inputSchema.title, name);
      assert.equal(entry!.inputSchema.additionalProperties, false);
      assert.ok(entry!.inputSchema.properties);
      assert.ok(Array.isArray(entry!.inputSchema.required));
    }
  });

  it("accepts example input and rejects bad input", () => {
    for (const name of TOOL_NAMES) {
      const schema = TOOL_CATALOGUE.find((t) => t.name === name)!.inputSchema;
      const fix = fixtures[name];
      assertValid(schema, fix.example);
      assert.ok(validateSchema(schema, fix.bad).length > 0, `${name} bad`);
    }
  });
});
