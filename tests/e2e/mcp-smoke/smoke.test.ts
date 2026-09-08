/**
 * WP12 e2e: mcp-smoke gate (real daemon + containers).
 * mcp-smoke.ts already takes the docker-int lock — do not nest another.
 * Skip with MODELBOT_TEST_SKIP_MCP_SMOKE=1.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SKIP = process.env.MODELBOT_TEST_SKIP_MCP_SMOKE === "1";

describe("WP12 mcp-smoke e2e", { skip: SKIP }, () => {
  it("scripts/mcp-smoke.ts exits 0 and writes receipt", () => {
    const r = spawnSync(
      process.execPath,
      ["--experimental-strip-types", join(ROOT, "scripts", "mcp-smoke.ts")],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env },
        timeout: 600_000,
      },
    );
    if (r.status !== 0) {
      console.error(r.stdout);
      console.error(r.stderr);
    }
    assert.equal(r.status, 0, `mcp-smoke failed: ${r.stderr || r.stdout}`);
    const receipt = join(ROOT, "docs", "internal", "build", "mcp-smoke-last.json");
    assert.ok(existsSync(receipt), "missing mcp-smoke-last.json");
    const body = JSON.parse(readFileSync(receipt, "utf8")) as {
      ok: boolean;
      rows: Array<{ ok: boolean; step: string }>;
    };
    assert.equal(body.ok, true);
    assert.ok(body.rows.every((row) => row.ok));
  });
});
