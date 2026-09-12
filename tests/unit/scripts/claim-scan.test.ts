import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = "tests/fixtures/claim-scan-forbidden.md";

function scan(args: string[] = []) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/claim-scan.ts", ...args],
    { cwd: ROOT, encoding: "utf8" },
  );
}

function namedHits(stderr: string, name: string): string[] {
  const re = new RegExp(String.raw`claim-scan-forbidden\.md:(\d+): ${name}:`, "g");
  return [...stderr.matchAll(re)].map((m) => m[1] ?? "");
}

test("fixture containing forbidden claims fails claim-scan", () => {
  const r = scan([FIXTURE]);
  assert.equal(r.status, 1, r.stderr || r.stdout);
  assert.match(r.stderr, /claim-scan FAIL/);
  assert.deepEqual(namedHits(r.stderr, "open source"), ["1", "6"]);
  assert.deepEqual(namedHits(r.stderr, "entirely local"), ["2", "10"]);
  assert.deepEqual(namedHits(r.stderr, "guaranteed"), ["3", "9", "11"]);
  assert.deepEqual(namedHits(r.stderr, "immune"), ["4"]);
  assert.deepEqual(namedHits(r.stderr, "unlimited"), ["5", "7", "8"]);
});

test("launch surfaces pass claim-scan", () => {
  const r = scan();
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /claim-scan OK/);
});
