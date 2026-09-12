import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

test("docs/CONFIG.md matches the config doc generator", () => {
  const out = join(mkdtempSync(join(tmpdir(), "mb-config-doc-")), "CONFIG.md");
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/gen-config-doc.ts", out],
    { cwd: ROOT, encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const generated = readFileSync(out, "utf8");
  const committed = readFileSync(join(ROOT, "docs/CONFIG.md"), "utf8");
  assert.equal(committed, generated, "docs/CONFIG.md is stale; run npm run docs:config");
  assert.match(
    generated,
    /Yaml from an older\ntemplate that still pins `policy\.kill_switch: true`/,
  );
  assert.match(generated, /\| `config_version` \|/);
  assert.match(
    generated,
    /Template generation stamp written by init\. Absent means an older template/,
  );
  assert.match(generated, /otherwise 4g/);
  assert.match(generated, /otherwise 2g/);
});
