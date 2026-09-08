/**
 * The committed docker-compose.yml is generated, so the only useful check is
 * that it still equals what the renderer produces — and that the docker-argv
 * builder the daemon actually uses still carries the hardening flags.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import {
  browserCreateArgs,
  renderProductComposeYaml,
  defaultComposeFilePath,
  composeConfigArgs,
  DEFAULT_LIMITS,
} from "../../../src/sandbox/index.ts";

const SECCOMP = "./sandbox/seccomp-chromium.json";
const WS = "/home/user/ModelBot/computers/demo/workspace";
const REPO = join(import.meta.dirname, "../../..");

describe("product compose file", () => {
  it("browser create argv carries the hardening flags", () => {
    const args = browserCreateArgs({
      name: "demo",
      workspaceHost: WS,
      workspaceGid: 23456,
      seccompPath: SECCOMP,
    });
    assert.ok(args.includes("--read-only"));
    assert.ok(args.includes("--cap-drop") && args.includes("ALL"));
    assert.ok(args.includes("no-new-privileges:true"));
    assert.ok(args.includes(`seccomp=${SECCOMP}`));
    assert.equal(args[args.indexOf("--user") + 1], "1001:1001");
    assert.equal(args[args.indexOf("--group-add") + 1], "23456");
    assert.equal(args[args.indexOf("--shm-size") + 1], DEFAULT_LIMITS.browserShm);
  });

  it("committed docker-compose.yml matches renderer", () => {
    const rendered = renderProductComposeYaml();
    const onDisk = readFileSync(defaultComposeFilePath(REPO), "utf8");
    assert.equal(onDisk, rendered);

    const doc = parseYaml(onDisk) as {
      services: Record<string, Record<string, unknown>>;
      networks: Record<string, Record<string, unknown>>;
    };
    assert.equal(doc.services.browser!.read_only, true);
    assert.deepEqual(doc.services.browser!.cap_drop, ["ALL"]);
    assert.equal(doc.services.browser!.shm_size, "1g");
    assert.ok(
      (doc.services.browser!.security_opt as string[]).some((s) =>
        s.includes("seccomp="),
      ),
    );
    assert.equal(doc.networks.internal!.internal, true);
    assert.ok(
      !(doc.services.shell!.volumes as string[]).some((v) =>
        v.includes("profile"),
      ),
    );
    assert.equal("daemon" in doc.services, false);
    assert.equal("modelbot" in doc.services, false);
  });

  it("docker compose config validates product file", () => {
    const args = composeConfigArgs(defaultComposeFilePath(REPO));
    const r = spawnSync("docker", args, {
      encoding: "utf8",
      cwd: REPO,
      env: {
        ...process.env,
        COMPUTER_NAME: "composeunit",
        WORKSPACE: "/tmp/modelbot-compose-unit-ws",
        INTERNAL_SUBNET: "10.233.77.0/24",
        INTERNAL_PROXY_IP: "10.233.77.2",
      },
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.ok((r.stdout ?? "").includes("modelbot-composeunit-browser"));
  });
});
