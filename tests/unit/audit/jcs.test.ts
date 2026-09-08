import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { canonicalJson } from "../../../src/audit/chain.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../fixtures/jcs");

describe("RFC 8785 JCS", () => {
  it("passes official cyberphone testdata vectors", () => {
    const inputDir = join(fixtures, "input");
    const names = readdirSync(inputDir).filter((n) => n.endsWith(".json")).sort();
    assert.ok(names.length >= 6, "expected official vector files");
    for (const name of names) {
      const input = JSON.parse(readFileSync(join(inputDir, name), "utf8"));
      const expected = readFileSync(join(fixtures, "output", name), "utf8").replace(
        /\n$/,
        "",
      );
      assert.equal(canonicalJson(input), expected, name);
    }
  });

  it("matches RFC 8785 Appendix B number samples (incl. 1e21, -0, reject NaN/Infinity)", () => {
    const rows = JSON.parse(
      readFileSync(join(fixtures, "rfc8785-appendix-b.json"), "utf8"),
    ) as Array<{ ieee: string; json?: string; reject?: boolean }>;
    assert.ok(rows.length >= 20);
    for (const row of rows) {
      const n = Buffer.from(row.ieee, "hex").readDoubleBE(0);
      if (row.reject) {
        assert.throws(() => canonicalJson(n), /not permitted/);
        continue;
      }
      assert.equal(canonicalJson(n), row.json, row.ieee);
    }
    assert.equal(canonicalJson(-0), "0");
    assert.equal(canonicalJson(1e20), "100000000000000000000");
    assert.equal(canonicalJson(1e21), "1e+21");
    assert.throws(() => canonicalJson(Number.NaN), /not permitted/);
    assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY), /not permitted/);
  });

  it("escapes strings per §3.2.2.2 and sorts keys by UTF-16 code units", () => {
    assert.equal(canonicalJson("\u000f"), '"\\u000f"');
    assert.equal(canonicalJson("A\"B\\C"), '"A\\"B\\\\C"');
    assert.equal(canonicalJson("\u2028"), '"\u2028"');
    const sorted = canonicalJson({ "1": "One", "\n": "Newline" });
    assert.equal(sorted, '{"\\n":"Newline","1":"One"}');
  });

  it("keeps existing audit-record canonical bytes (chain v=1, no bump)", () => {
    const doc = JSON.parse(
      readFileSync(join(fixtures, "audit-regression.json"), "utf8"),
    ) as { payloads: Array<{ payload: unknown; canonical: string }> };
    for (const row of doc.payloads) {
      assert.equal(canonicalJson(row.payload), row.canonical);
    }
  });
});
