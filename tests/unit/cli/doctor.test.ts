import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatDoctorReport,
  isPublicBind,
  isTagOnlyImage,
  mountsDockerSock,
  runSecurityAudit,
  type SecurityAuditInput,
} from "../../../src/cli/doctor.ts";

test("the security audit report is stable against fixed input", () => {
  const input: SecurityAuditInput = {
    bind: "0.0.0.0",
    port: 7777,
    mcpTokenPresent: true,
    bootstrapTokenPresent: true,
    vaultMode: "passphrase",
    vaultPath: "/tmp/vault.enc",
    images: ["modelbot/browser:dev"],
    containers: [
      {
        Name: "/modelbot-x-browser",
        HostConfig: {
          Privileged: false,
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          Binds: ["/var/run/docker.sock:/var/run/docker.sock"],
        },
      },
    ],
    proxyDenylistActive: true,
    auditChain: { ok: true, detail: "OK 0 records" },
  };
  const checks = runSecurityAudit(input);
  const report = formatDoctorReport(checks);
  assert.equal(
    report,
    [
      "modelbot doctor",
      "bind: FAIL public bind 0.0.0.0:7777",
      "tokens: PASS mcp=yes bootstrap=yes",
      "docker.sock: FAIL mounted in /modelbot-x-browser",
      "hardening: PASS ok",
      "image_digest: PASS mvp-dev-tags: modelbot/browser:dev",
      "proxy_denylist: PASS active",
      "vault: PASS passphrase path=/tmp/vault.enc",
      "audit_chain: PASS OK 0 records",
      "RESULT: FAIL (2)",
      "",
    ].join("\n"),
  );
  assert.equal(isPublicBind("0.0.0.0"), true);
  assert.equal(isTagOnlyImage("modelbot/browser:dev"), true);
  assert.equal(
    isTagOnlyImage("modelbot/browser@sha256:" + "a".repeat(64)),
    false,
  );
  assert.equal(mountsDockerSock(input.containers[0]!), true);

  const releaseTag = runSecurityAudit({
    ...input,
    bind: "127.0.0.1",
    containers: [],
    images: ["modelbot/browser:1.0.0"],
  });
  assert.ok(
    releaseTag.some(
      (c) =>
        c.id === "image_digest" &&
        c.severity === "FAIL" &&
        c.detail.includes("modelbot/browser:1.0.0"),
    ),
  );
});
