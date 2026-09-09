import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { planSshSteps, sshTunnelCommand } from "../../../src/deploy/ssh.ts";
import { DAEMON_PORT } from "../../../src/deploy/types.ts";

describe("ssh provider step planner", () => {
  it("preflights prerequisites and initializes private state before starting the service", () => {
    const steps = planSshSteps({
      user: "ubuntu",
      host: "10.0.0.5",
      sshKeyPath: "/tmp/id_ed25519",
      tarballPath: "modelbot-0.0.1.tgz",
    });
    const ids = steps.map((s) => s.id);
    assert.deepEqual(ids, [
      "preflight",
      "ensure-dirs",
      "copy-tarball",
      "npm-install",
      "init-config",
      "write-systemd",
      "enable-daemon",
      "print-ssh-tunnel",
    ]);
    assert.ok(steps.every((s) => s.command.length > 0));
    for (const step of steps) {
      const syntax = spawnSync("/bin/sh", ["-n"], { input: step.command, encoding: "utf8" });
      assert.equal(syntax.status, 0, `${step.id}: ${syntax.stderr}`);
    }
    const init = steps.find((s) => s.id === "init-config")!.command;
    assert.match(init, /init --skip-detect --skip-images/);
    assert.match(init, /chmod 0600/);
    assert.doesNotMatch(init, /--force|version: 1/);
    assert.match(steps.find((s) => s.id === "preflight")!.command, /major<22/);
    assert.match(steps.find((s) => s.id === "preflight")!.command, /docker image inspect/);
    assert.match(steps.find((s) => s.id === "enable-daemon")!.command, /healthz/);
    assert.match(
      steps.find((s) => s.id === "write-systemd")!.command,
      /MODELBOT_PORT=7777/,
    );
    assert.equal(
      steps.find((s) => s.id === "print-ssh-tunnel")!.command,
      sshTunnelCommand("ubuntu", "10.0.0.5"),
    );
    assert.equal(
      sshTunnelCommand("ubuntu", "10.0.0.5"),
      `ssh -L ${DAEMON_PORT}:127.0.0.1:${DAEMON_PORT} ubuntu@10.0.0.5`,
    );
    assert.ok(!steps.some((s) => /privileged/i.test(s.command)));
  });

  it("uses tailscale serve when authkey given (key redacted)", () => {
    const steps = planSshSteps({
      user: "root",
      host: "203.0.113.9",
      tailscaleAuthkey: "tskey-auth-SECRET",
      publicOrigin: "https://modelbot.example.ts.net",
    });
    const ids = steps.map((s) => s.id);
    assert.ok(ids.includes("install-tailscale"));
    assert.ok(ids.includes("tailscale-up"));
    assert.ok(ids.includes("tailscale-serve"));
    assert.ok(!ids.includes("print-ssh-tunnel"));
    const up = steps.find((s) => s.id === "tailscale-up")!;
    assert.match(up.command, /REDACTED/);
    assert.doesNotMatch(up.command, /tskey-auth-SECRET/);
    for (const step of steps) assert.equal(spawnSync("/bin/sh", ["-n"], {input: step.command, encoding:"utf8"}).status, 0, step.id);
    assert.ok(ids.indexOf("configure-origin") < ids.indexOf("enable-daemon"));
    assert.match(steps.find(s=>s.id==="preflight")!.command, /modelbot\/computer:dev/);
    const serve = steps.find((s) => s.id === "tailscale-serve")!;
    assert.match(serve.command, new RegExp(`tailscale serve --bg http://127.0.0.1:${DAEMON_PORT}`));
  });
});

it("headless credential and existing tailnet are explicit, private and ordered before start", () => {
  const steps = planSshSteps({ user: "modelbot", host: "server.example", tailscaleServe: true,
    publicOrigin: "https://modelbot.example.ts.net", systemdCredential: "/home/modelbot/.config/modelbot/vault.cred" });
  const all = steps.map(s => s.command).join("\n");
  assert.doesNotMatch(all, /MODELBOT_VAULT_KEY_HEX|tailscale up|funnel|--host 0\.0\.0\.0/);
  assert.match(all, /LoadCredentialEncrypted=modelbot-vault:/);
  assert.match(steps.find(s => s.id === "init-config")!.command, /systemd-run --user --wait/);
  assert.doesNotMatch(steps.find(s => s.id === "preflight")!.command, /secret-tool/);
  assert.match(steps.find(s => s.id === "preflight")!.command, /systemctl --version[^\n]*-ge 258/);
  assert.match(steps.find(s => s.id === "preflight")!.command, /LoadCredentialEncrypted=modelbot-vault:[^\n]+ \/usr\/bin\/true/);
  assert.doesNotMatch(steps.find(s => s.id === "preflight")!.command, /\$\(systemd --version/);
  for (const step of steps) assert.equal(spawnSync("/bin/sh", ["-n"], {input:step.command, encoding:"utf8"}).status, 0, step.id);
  assert.throws(() => planSshSteps({ user:"modelbot", host:"server.example", tailscaleServe:true }), /public-origin/);
  assert.throws(() => planSshSteps({ user:"modelbot", host:"server.example", systemdCredential:"/tmp/key%h" }), /absolute remote path/);
});
