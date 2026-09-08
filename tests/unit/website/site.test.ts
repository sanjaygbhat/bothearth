import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
test("static site builds and checks both the custom domain and a Pages project path", () => {
  const run = (script: string, site: string) => {
    const result = spawnSync(process.execPath, [script], {
      cwd: root, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, SITE_URL: site },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  };
  const config = JSON.parse(readFileSync(new URL("../../../website/site.json", import.meta.url), "utf8"));
  try {
    for (const site of [config.url, "https://sanjaygbhat.github.io/bothearth/"]) {
      run("scripts/build-site.mjs", site);
      run("scripts/check-site.mjs", site);
    }
    const invalid = spawnSync(process.execPath, ["scripts/build-site.mjs"], {
      cwd: root, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, SITE_URL: "https://example.com/?tracking=1" },
    });
    assert.notEqual(invalid.status, 0, "Query-bearing canonical URL must be rejected");
  } finally {
    run("scripts/build-site.mjs", config.url);
  }
});
