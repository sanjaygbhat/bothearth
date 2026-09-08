import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  browserCreateArgs,
  shellCreateArgs,
  proxyCreateArgs,
  networkCreateArgs,
  execStdioArgs,
  LABEL_COMPUTER,
  DEFAULT_LIMITS,
} from "../../../src/sandbox/flags.ts";

const SECCOMP = "/repo/sandbox/seccomp-chromium.json";
const WS = "/home/user/ModelBot/computers/demo/workspace";

describe("sandbox flag builder golden", () => {
  it("both roles join the actual workspace group without changing their UID", () => {
    for (const build of [browserCreateArgs, shellCreateArgs]) {
      const args = build({ name: "demo", workspaceHost: WS, workspaceGid: 23456, seccompPath: SECCOMP });
      assert.equal(args[args.indexOf("--group-add") + 1], "23456");
      assert.equal(args.includes("--privileged"), false);
    }
  });
  it("network internal has --internal", () => {
    const args = networkCreateArgs("demo", "internal");
    assert.ok(args.includes("--internal"));
    assert.ok(args.includes("modelbot-demo-internal"));
    assert.ok(args.includes(`${LABEL_COMPUTER}=demo`) || args.includes(LABEL_COMPUTER));
  });

  it("browser argv has every hardening flag", () => {
    const args = browserCreateArgs({
      name: "demo",
      workspaceHost: WS,
      seccompPath: SECCOMP,
    });
    const s = args.join("\0");
    assert.ok(args.includes("--read-only"));
    assert.ok(args.includes("--cap-drop") && args.includes("ALL"));
    assert.ok(args.includes("no-new-privileges:true"));
    assert.ok(args.includes(`seccomp=${SECCOMP}`));
    assert.ok(args.includes("--shm-size") && args.includes(DEFAULT_LIMITS.browserShm));
    assert.ok(args.includes("--memory") && args.includes("2g"));
    assert.ok(args.includes("--pids-limit") && args.includes("512"));
    assert.ok(args.includes("--cpus") && args.includes("2"));
    assert.ok(args.includes("--user") && args.includes("1001:1001"));
    assert.ok(s.includes("/tmp:rw,noexec,nosuid,nodev,size=512m"));
    assert.ok(s.includes("/run:rw,noexec,nosuid,nodev,size=16m"));
    assert.ok(s.includes("/quarantine:rw,noexec,nosuid,nodev"));
    assert.ok(s.includes("MODELBOT_QUARANTINE=/quarantine"));
    assert.ok(s.includes("source=modelbot-demo-profile") && s.includes("target=/home/browser/profile"));
    assert.ok(s.includes(`source=${WS}`) && s.includes("target=/workspace"));
    assert.ok(s.includes("HTTP_PROXY=http://proxy:3128"));
    assert.equal(args.includes("-p"), false);
    assert.equal(args.includes("--publish"), false);
    assert.ok(!s.includes("docker.sock"));
    assert.equal(args.at(-1), "modelbot/computer:dev");
  });

  it("shell argv has no profile volume and no shm", () => {
    const args = shellCreateArgs({
      name: "demo",
      workspaceHost: WS,
      seccompPath: SECCOMP,
    });
    const s = args.join("\0");
    assert.ok(args.includes("--read-only"));
    assert.ok(args.includes("--cap-drop") && args.includes("ALL"));
    assert.ok(args.includes("no-new-privileges:true"));
    assert.ok(args.includes("--user") && args.includes("1002:1002"));
    assert.ok(args.includes("--memory") && args.includes("512m"));
    assert.equal(args.includes("--shm-size"), false);
    assert.ok(!s.includes("profile"));
    assert.ok(!s.includes("/quarantine"));
    assert.ok(!s.includes("seccomp="));
    assert.ok(s.includes(`source=${WS}`) && s.includes("target=/workspace"));
    assert.equal(args.at(-1), "modelbot/shell:dev");
  });

  it("proxy create attaches egress network only", () => {
    const args = proxyCreateArgs({
      name: "demo",
      workspaceHost: WS,
      seccompPath: SECCOMP,
    });
    assert.ok(args.includes("modelbot-demo-egress"));
    assert.ok(args.includes("modelbot/proxy:dev"));
    assert.ok(args.includes("max-size=1m"));
    assert.ok(args.includes("max-file=3"));
  });

  it("exec argv", () => {
    assert.deepEqual(execStdioArgs("modelbot-demo-browser"), [
      "exec",
      "-i",
      "modelbot-demo-browser",
      "node",
      "/opt/computer-server/stdio.js",
    ]);
  });
});
