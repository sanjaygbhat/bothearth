import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { AuditLog } from "../../../src/audit/log.ts";
import { createVault, ensureAuditHmacKey, vaultAuditKeyProvider } from "../../../src/vault/index.ts";
import {
  dockerMemoryHeadroomWarning,
  formatDoctorReport,
  isPublicBind,
  isTagOnlyImage,
  mountsDockerSock,
  runDoctorCli,
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
          ShmSize: 1024 ** 3,
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
      "Ask before sensitive actions: off",
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

async function doctorJson(opts: Parameters<typeof runDoctorCli>[1]) {
  let stdout = "";
  const write = mock.method(process.stdout, "write", (chunk: string | Buffer) => {
    stdout += String(chunk);
    return true;
  });
  try {
    const code = await runDoctorCli(["--json"], opts);
    return { code, ...JSON.parse(stdout) } as {
      code: number;
      result: string;
      checks: Array<{ id: string; severity: string; detail: string }>;
    };
  } finally {
    write.mock.restore();
  }
}

test("doctor discovers managed containers, audits their actual images, and limits browser shm without exempting shell/proxy hardening", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mb-doctor-containers-"));
  const configFile = join(home, "modelbot.yaml");
  writeFileSync(configFile, JSON.stringify({ sandbox: { image_browser: "modelbot/browser:dev" } }));
  writeFileSync(join(home, "tokens.json"), JSON.stringify({ mcp_token: "fixture", bootstrap_token_hash: "fixture" }));
  const containers = ["browser", "shell", "proxy"].map((role) => ({
    Name: `/modelbot-fixture-${role}`,
    Config: { Image: `modelbot/${role === "browser" ? "computer" : role}:dev` },
    HostConfig: {
      Privileged: false, ReadonlyRootfs: true, CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"], ShmSize: role === "browser" ? 1024 ** 3 : 64 * 1024 ** 2,
    },
    Mounts: [] as Array<{ Source: string; Destination: string }>,
  }));
  const ids = ["a".repeat(12), "b".repeat(12), "c".repeat(12)];
  const calls: string[][] = [];
  const diagnostic = t.mock.method(console, "error", () => {});
  const report = await doctorJson({ home, configFile, cli: { run: async (args) => {
    console.log("fixture runtime diagnostic");
    calls.push(args);
    return args[0] === "ps" ? ids.join("\n") : containers.map((c) => JSON.stringify(c)).join("\n");
  } } });
  assert.equal(report.code, 0);
  assert.equal(diagnostic.mock.callCount(), 2);
  assert.deepEqual(calls[0], ["ps", "--all", "--quiet", "--filter", "label=modelbot.computer"]);
  assert.deepEqual(calls[1]!.slice(0, 2), ["inspect", "--format"]);
  assert.deepEqual(calls[1]!.slice(3), ids);
  assert.match(calls[1]![2]!, /\.Config\.Image/);
  assert.doesNotMatch(calls[1]![2]!, /\.Env|json \.Config\}\}|json \.HostConfig\}\}/);
  assert.match(report.checks.find((c) => c.id === "container_runtime")!.detail, /inspected 3 managed/);
  assert.equal(report.checks.find((c) => c.id === "hardening")!.severity, "PASS");
  assert.match(report.checks.find((c) => c.id === "image_digest")!.detail, /modelbot\/computer:dev/);
  assert.match(report.checks.find((c) => c.id === "image_digest")!.detail, /modelbot\/proxy:dev/);

  containers[0]!.HostConfig.ShmSize = 64 * 1024 ** 2;
  containers[1]!.HostConfig.ReadonlyRootfs = false;
  containers[2]!.Mounts.push({ Source: "/var/run/docker.sock", Destination: "/run/docker.sock" });
  containers[2]!.Config.Image = "modelbot/proxy:latest";
  const bad = await doctorJson({ home, configFile, containers, cli: { run: async () => {
    throw new Error("injected containers must skip runtime discovery");
  } } });
  assert.equal(bad.code, 1);
  assert.equal(bad.checks.some((c) => c.id === "container_runtime"), false);
  assert.match(bad.checks.find((c) => c.id === "hardening")!.detail, /fixture-browser: shm_too_small=/);
  assert.match(bad.checks.find((c) => c.id === "hardening")!.detail, /fixture-shell: readonly_rootfs=false/);
  assert.equal(bad.checks.find((c) => c.id === "docker.sock")!.severity, "FAIL");
  assert.match(bad.checks.find((c) => c.id === "image_digest")!.detail, /modelbot\/proxy:latest/);
});

test("doctor distinguishes failed or incomplete runtime inspection from a verified empty inventory", async () => {
  const home = mkdtempSync(join(tmpdir(), "mb-doctor-runtime-"));
  const configFile = join(home, "missing.yaml");
  for (const run of [
    async () => { throw new Error("private runtime error payload"); },
    async (args: string[]) => args[0] === "ps" ? "a".repeat(12) : "",
    async (args: string[]) => args[0] === "ps" ? "a".repeat(12) : "not JSON",
  ]) {
    const report = await doctorJson({ home, configFile, cli: { run } });
    assert.equal(report.code, 1);
    assert.equal(report.checks.find((c) => c.id === "container_runtime")!.severity, "FAIL");
    for (const id of ["docker.sock", "hardening"]) {
      assert.equal(report.checks.find((c) => c.id === id)!.severity, "WARN");
      assert.match(report.checks.find((c) => c.id === id)!.detail, /not checked/);
    }
    assert.doesNotMatch(JSON.stringify(report), /private runtime error payload/);
  }
  const empty = await doctorJson({ home, configFile, cli: { run: async (args) => {
    assert.equal(args[0], "ps", "an empty list must not inspect every container");
    return "";
  } } });
  assert.equal(empty.checks.find((c) => c.id === "container_runtime")!.severity, "PASS");
  assert.equal(empty.checks.find((c) => c.id === "hardening")!.severity, "INFO");
});

test("doctor and audit verify use the configured vault audit key, including remote config overrides", async () => {
  const home = mkdtempSync(join(tmpdir(), "mb-doctor-config-"));
  const vaultPath = join(home, "vault.enc"), auditPath = join(home, "audit.jsonl");
  const key = Buffer.alloc(32, 11);
  const vault = await createVault({ path: vaultPath, provider: {
    kind: "env", resolve: async () => ({ kind: "env", key }),
  } });
  await ensureAuditHmacKey(vault);
  await new AuditLog({ path: auditPath, keyProvider: vaultAuditKeyProvider(vault) })
    .append({ type: "task.started", body: {} });
  const config = JSON.stringify({ data_dir: home, vault: { path: vaultPath }, audit: { path: auditPath } });
  writeFileSync(join(home, "modelbot.yaml"), config, { mode: 0o600 });
  writeFileSync(join(home, "remote.yaml"), config, { mode: 0o600 });
  writeFileSync(join(home, "tokens.json"), JSON.stringify({ mcp_token: "fixture", bootstrap_token_hash: "fixture" }), { mode: 0o600 });
  const env = { ...process.env, MODELBOT_HOME: home, MODELBOT_CONFIG: "", MODELBOT_VAULT_KEY_HEX: key.toString("hex"),
    MODELBOT_AUDIT_KEY_HEX: "", MODELBOT_AUDIT_KEY: "" };
  for (const remote of [false, true]) {
    const cliEnv = remote ? { ...env, MODELBOT_CONFIG: join(home, "remote.yaml") } : env;
    // An unset config override is distinct from an invalid empty path.
    if (!remote) delete (cliEnv as NodeJS.ProcessEnv).MODELBOT_CONFIG;
    for (const args of [["doctor", "--json"], ["audit", "verify"]]) {
      const command = args[0] === "doctor"
        ? ["--input-type=module", "--eval", `import { runDoctorCli } from ${JSON.stringify(new URL("../../../src/cli/doctor.ts", import.meta.url).href)}; process.exit(await runDoctorCli(["--json"], { containers: [] }));`]
        : [new URL("../../../src/cli/index.ts", import.meta.url).pathname, ...args];
      const result = spawnSync(process.execPath, command,
        { cwd: home, env: cliEnv, encoding: "utf8", timeout: 10_000 });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      if (args[0] === "doctor") {
        const report = JSON.parse(result.stdout);
        assert.deepEqual(report.checks.find((check: { id: string }) => check.id === "audit_chain"),
          { id: "audit_chain", severity: "PASS", detail: "OK 1 records" });
      } else assert.match(result.stdout, /OK 1 records/);
    }
  }
});

test("doctor reports armed policy.gates as on and an empty list as off, both PASS", async () => {
  const home = mkdtempSync(join(tmpdir(), "mb-doctor-gates-"));
  const configFile = join(home, "modelbot.yaml");
  writeFileSync(
    join(home, "tokens.json"),
    JSON.stringify({ mcp_token: "fixture", bootstrap_token_hash: "fixture" }),
  );
  const gates = ["external_send", "payment", "upload", "delete", "new_domain"];
  const expectedOn =
    `on (policy.gates in ${configFile}: ${gates.join(", ")}) — turn off in Settings → Sensitive actions`;
  const base: SecurityAuditInput = {
    bind: "127.0.0.1",
    port: 7777,
    mcpTokenPresent: true,
    bootstrapTokenPresent: true,
    vaultMode: "missing",
    images: [],
    containers: [],
    proxyDenylistActive: true,
    auditChain: { ok: true, detail: "n/a" },
  };
  assert.deepEqual(runSecurityAudit(base).find((c) => c.id === "ask_before_sensitive"), {
    id: "ask_before_sensitive",
    severity: "PASS",
    detail: "off",
  });
  assert.deepEqual(
    runSecurityAudit({ ...base, policyGates: gates, configPath: configFile })
      .find((c) => c.id === "ask_before_sensitive"),
    { id: "ask_before_sensitive", severity: "PASS", detail: expectedOn },
  );
  const report = formatDoctorReport(
    runSecurityAudit({ ...base, policyGates: gates, configPath: configFile }),
  );
  assert.ok(report.split("\n").includes(`Ask before sensitive actions: ${expectedOn}`));
  assert.ok(report.split("\n").includes("RESULT: PASS"));

  writeFileSync(configFile, JSON.stringify({ version: 1, data_dir: home }));
  const off = await doctorJson({ home, configFile, containers: [] });
  assert.equal(off.code, 0);
  assert.equal(off.result, "PASS");
  assert.deepEqual(off.checks.find((c) => c.id === "ask_before_sensitive"), {
    id: "ask_before_sensitive",
    severity: "PASS",
    detail: "off",
  });

  writeFileSync(configFile, JSON.stringify({ data_dir: home, policy: { gates } }));
  const on = await doctorJson({ home, configFile, containers: [] });
  assert.equal(on.code, 0);
  assert.equal(on.result, "PASS");
  assert.deepEqual(on.checks.find((c) => c.id === "ask_before_sensitive"), {
    id: "ask_before_sensitive",
    severity: "PASS",
    detail: expectedOn,
  });
});

test("doctor warns when Docker MemTotal is below browser+shell limits plus 1 GiB", async () => {
  const gib = 1024 ** 3;
  const warn = dockerMemoryHeadroomWarning(4 * gib, "4g", "512m");
  assert.ok(warn);
  assert.match(warn!, /Docker total memory is 4 GiB/);
  assert.match(warn!, /browser 4g/);
  assert.match(warn!, /shell 512m/);
  assert.match(warn!, /1g headroom needs 5\.5 GiB/);
  assert.match(warn!, /Raise Docker's memory/);
  assert.equal(dockerMemoryHeadroomWarning(6 * gib, "4g", "512m"), null);

  const base: SecurityAuditInput = {
    bind: "127.0.0.1",
    port: 7777,
    mcpTokenPresent: true,
    bootstrapTokenPresent: true,
    vaultMode: "missing",
    images: [],
    containers: [],
    proxyDenylistActive: true,
    auditChain: { ok: true, detail: "n/a" },
  };
  const low = runSecurityAudit({ ...base, dockerMemTotalBytes: 4 * gib });
  const lowRow = low.find((c) => c.id === "docker_memory");
  assert.equal(lowRow?.severity, "WARN");
  assert.equal(lowRow?.detail, warn);
  const report = formatDoctorReport(low);
  assert.ok(report.split("\n").includes(`docker_memory: WARN ${warn}`));
  assert.ok(report.split("\n").includes("RESULT: PASS"));

  const ok = runSecurityAudit({ ...base, dockerMemTotalBytes: 6 * gib });
  assert.equal(ok.find((c) => c.id === "docker_memory")?.severity, "PASS");
  assert.equal(runSecurityAudit(base).some((c) => c.id === "docker_memory"), false);

  const home = mkdtempSync(join(tmpdir(), "mb-doctor-mem-"));
  const configFile = join(home, "modelbot.yaml");
  writeFileSync(join(home, "tokens.json"), JSON.stringify({ mcp_token: "fixture", bootstrap_token_hash: "fixture" }));
  writeFileSync(configFile, JSON.stringify({ sandbox: { memory: "8g" } }));
  const yaml = await doctorJson({
    home,
    configFile,
    containers: [],
    dockerMemTotalBytes: 6 * gib,
    cli: { run: async () => "" },
  });
  const yamlRow = yaml.checks.find((c) => c.id === "docker_memory");
  assert.equal(yamlRow?.severity, "WARN");
  assert.match(yamlRow!.detail, /browser 8g/);
  assert.doesNotMatch(yamlRow!.detail, /browser 4g/);
  assert.equal(yaml.code, 0);

  writeFileSync(configFile, JSON.stringify({ sandbox: { runtime: "auto" } }));
  const def = await doctorJson({
    home,
    configFile,
    containers: [],
    dockerMemTotalBytes: 6 * gib,
    cli: { run: async () => "" },
  });
  const defRow = def.checks.find((c) => c.id === "docker_memory");
  assert.equal(defRow?.severity, "PASS");
  assert.match(defRow!.detail, /browser 4g/);
});
