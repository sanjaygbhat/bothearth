import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { resolveDesktopEnv } from "../../../computer-server/src/native-process.ts";

function spawnEnv(env: NodeJS.ProcessEnv): Promise<{ DISPLAY?: string; XAUTHORITY?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e",
      "process.stdout.write(JSON.stringify({DISPLAY:process.env.DISPLAY,XAUTHORITY:process.env.XAUTHORITY}))"], { env });
    let out = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", chunk => { out += chunk; });
    child.once("error", reject);
    child.once("close", code => {
      if (code !== 0) reject(new Error(`spawn exited ${code}`));
      else resolve(JSON.parse(out) as { DISPLAY?: string; XAUTHORITY?: string });
    });
  });
}

test("missing Xauthority still spawns with DISPLAY and without XAUTHORITY", async () => {
  const env = resolveDesktopEnv({ PATH: process.env.PATH, XAUTHORITY: "/stale" }, [], () => false);
  assert.equal(env.DISPLAY, ":99");
  assert.equal("XAUTHORITY" in env, false);
  const seen = await spawnEnv(env);
  assert.equal(seen.DISPLAY, ":99");
  assert.equal(seen.XAUTHORITY, undefined);
});

test("existing Xauthority is exported to the spawned command", async () => {
  const file = "/tmp/modelbot-chromium-xy/Xauthority";
  const env = resolveDesktopEnv({ PATH: process.env.PATH }, ["modelbot-chromium-xy"], path => path === file);
  assert.equal(env.DISPLAY, ":99");
  assert.equal(env.XAUTHORITY, file);
  const seen = await spawnEnv(env);
  assert.equal(seen.DISPLAY, ":99");
  assert.equal(seen.XAUTHORITY, file);
});
