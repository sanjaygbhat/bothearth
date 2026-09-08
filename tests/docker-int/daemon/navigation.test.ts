import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { browserRuntimeFlags } from "../../../src/sandbox/flags.ts";
import { withDockerLock } from "../lock.ts";

test("real browser prevents undeclared top-level destinations across action paths", { timeout: 120_000 }, async () => {
  await withDockerLock(async () => {
    const result = spawnSync("docker", ["run", "--rm", "--network", "none",
      ...browserRuntimeFlags(resolve("sandbox/seccomp-chromium.json")),
      "--tmpfs", "/home/browser/profile:rw,uid=1001,gid=1001,mode=0700",
      "--tmpfs", "/workspace:rw,uid=1001,gid=1001,mode=0700",
      "--mount", `type=bind,src=${resolve("tests/fixtures/navigation-guard.mjs")},dst=/tmp/navigation-guard.mjs,readonly`,
      "-e", "MODELBOT_PROXY_SERVER=http://127.0.0.1:9", "-e", "MODELBOT_PROXY_BYPASS=127.0.0.1,localhost",
      process.env.MODELBOT_TEST_NAV_IMAGE ?? "modelbot/computer:dev", "node", "/tmp/navigation-guard.mjs",
    ], { encoding: "utf8", timeout: 100_000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /NAVIGATION_PRECONTACT_PASS/);
  });
});
