import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { renderCloudInit, renderSystemdUnit } from "../../../src/deploy/cloud-init.ts";

const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(
  here,
  "../../fixtures/deploy/cloud-init.golden.yaml",
);

describe("cloud-init render", () => {
  it("matches golden YAML for ubuntu defaults", () => {
    const rendered = renderCloudInit({
      distro: "ubuntu",
      version: "0.0.1",
      hostname: "modelbot",
    });
    const golden = readFileSync(goldenPath, "utf8");
    assert.equal(rendered, golden);
  });

  it("never publishes UI ports or privileged", () => {
    const y = renderCloudInit();
    assert.match(y, /127\.0\.0\.1:7777/);
    assert.doesNotMatch(y, /0\.0\.0\.0/);
    assert.doesNotMatch(y, /privileged/i);
    assert.doesNotMatch(y, /:3000/);
    assert.doesNotMatch(y, /TS_AUTHKEY/);
  });

  it("debian switches docker apt path", () => {
    const y = renderCloudInit({ distro: "debian" });
    assert.match(y, /linux\/debian/);
    assert.doesNotMatch(y, /linux\/ubuntu/);
  });

  it("systemd unit binds loopback 7777", () => {
    const u = renderSystemdUnit();
    assert.match(u, /MODELBOT_HOST=127\.0\.0\.1/);
    assert.match(u, /MODELBOT_PORT=7777/);
    assert.match(u, /--host 127\.0\.0\.1 --port 7777/);
    assert.doesNotMatch(u, /privileged/i);
  });
  it("user service uses the initialized user's home and private umask", () => {
    const unit = renderSystemdUnit({ userService: true, configPath: "%h/.modelbot/modelbot.yaml" });
    assert.match(unit, /UMask=0077/);
    assert.match(unit, /MODELBOT_CONFIG=%h\/\.modelbot\/modelbot.yaml/);
    assert.match(unit, /WantedBy=default.target/);
    assert.doesNotMatch(unit, /Requires=docker.service/);
  });
});
