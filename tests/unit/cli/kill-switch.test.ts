/**
 * policy.kill_switch is off unless a versioned yaml sets it. An old template
 * `true` is ignored (doctor INFO); a versioned `true` still warns.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import {
  formatDoctorReport,
  killSwitchTrueWarning,
  runDoctorCli,
  runSecurityAudit,
  type SecurityAuditInput,
} from "../../../src/cli/doctor.ts";
import { runInit } from "../../../src/cli/init.ts";
import { configPath } from "../../../src/cli/paths.ts";
import { buildProductionComposition } from "../../../src/cli/start.ts";
import { FakeComputer } from "../../../src/computer-client/fake.ts";
import {
  CONFIG_VERSION,
  loadModelbotSchema,
  templateMigrationLines,
  validateModelbotConfig,
  withDefaults,
} from "../../../src/config/load.ts";
import { createToolDispatcher } from "../../../src/daemon/dispatcher.ts";
import { Store } from "../../../src/daemon/store.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const ENV_KEYS = [
  "MODELBOT_HOME",
  "MODELBOT_CONFIG",
  "MODELBOT_DATA_DIR",
  "MODELBOT_SQLITE_PATH",
  "MODELBOT_MCP_TOKEN",
  "MODELBOT_TOKEN",
  "MODELBOT_BOOTSTRAP_TOKEN",
  "MODELBOT_HOST",
  "MODELBOT_BIND",
  "MODELBOT_PORT",
  "MODELBOT_ALLOW_PUBLIC_BIND",
  "MODELBOT_WORKSPACE_ROOT",
  "MODELBOT_VAULT_KEY_HEX",
] as const;

async function withCleanStartEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  try {
    return await fn();
  } finally {
    for (const key of ENV_KEYS) {
      const prev = saved[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }
}

function killWarnings(lines: string[]): string[] {
  return lines.filter((line) => line.includes("policy.kill_switch is true"));
}

describe("policy.kill_switch", () => {
  it("defaults off when the key is absent", () => {
    const schema = loadModelbotSchema();
    const empty = validateModelbotConfig({}, schema);
    assert.equal(empty.policy.kill_switch, false);
    const filled = withDefaults({}) as { policy: { kill_switch: boolean } };
    assert.equal(filled.policy.kill_switch, false);
    assert.equal(
      validateModelbotConfig({ policy: { kill_switch: true } }, schema).policy.kill_switch,
      false,
    );
    assert.equal(
      validateModelbotConfig(
        { config_version: CONFIG_VERSION, policy: { kill_switch: true } },
        schema,
      ).policy.kill_switch,
      true,
    );
  });

  it("init yaml does not emit kill_switch: true", async () => {
    await withCleanStartEnv(async () => {
      const home = mkdtempSync(join(tmpdir(), "mb-ks-init-"));
      process.env.MODELBOT_VAULT_KEY_HEX = Buffer.alloc(32, 7).toString("hex");
      await runInit([
        "--home",
        home,
        "--data-dir",
        join(home, "data"),
        "--skip-detect",
        "--skip-images",
        "--quiet",
        "--force",
      ]);
      const text = readFileSync(configPath(home), "utf8");
      assert.equal(/kill_switch\s*:\s*true/.test(text), false);
    });
  });

  it("CONFIG.md says true denies every tool call", () => {
    const md = readFileSync(join(root, "docs/CONFIG.md"), "utf8");
    assert.match(md, /denies every tool call through `evaluateGate`/);
    assert.match(md, /`browser_snapshot`/);
    assert.match(md, /`done`/);
    assert.match(md, /`request_takeover`/);
  });

  it("dispatcher denies browser_click with E_POLICY kill_switch", async () => {
    const store = new Store();
    const computer = new FakeComputer("ks-click");
    store.insertComputer({
      id: computer.computerId,
      name: "ks",
      capabilities: ["browser"],
      persistent: false,
      status: "running",
    });
    const task = store.insertTask({
      computer_id: computer.computerId,
      goal: "click",
      max_steps: 5,
    });
    const dispatcher = createToolDispatcher({
      store,
      getClient: () => computer,
      emit: async () => {},
      enabledGates: [],
      killSwitch: true,
    });
    try {
      const click = await dispatcher.dispatch(
        "browser_click",
        { ref: "e1" },
        {
          taskId: task.id,
          computerId: computer.computerId,
          origin: "https://example.com",
        },
      );
      assert.equal(click.ok, false);
      assert.equal(!click.ok && click.error.code, "E_POLICY");
      assert.equal(!click.ok && click.error.message, "kill_switch");
    } finally {
      await computer.close();
      store.close();
    }
  });

  it("start composition forwards the loaded flag and warns once when true", async () => {
    await withCleanStartEnv(async () => {
      const home = mkdtempSync(join(tmpdir(), "mb-ks-start-"));
      process.env.MODELBOT_VAULT_KEY_HEX = Buffer.alloc(32, 7).toString("hex");
      await runInit([
        "--home",
        home,
        "--data-dir",
        join(home, "data"),
        "--skip-detect",
        "--skip-images",
        "--quiet",
        "--force",
      ]);
      const cfg = configPath(home);
      const warned: string[] = [];
      const warn = mock.method(console, "warn", (...args: unknown[]) => {
        warned.push(args.map(String).join(" "));
      });
      try {
        const shipped = await buildProductionComposition({ home, port: 0 });
        assert.equal(shipped.daemon.killSwitch, false);
        assert.equal(shipped.config.policy.kill_switch, false);
        assert.equal(killWarnings(warned).length, 0);

        writeFileSync(cfg, `${readFileSync(cfg, "utf8")}policy:\n  kill_switch: true\n`);
        const armed = await buildProductionComposition({ home, port: 0 });
        assert.equal(armed.daemon.killSwitch, true);
        assert.equal(armed.config.policy.kill_switch, true);
        const hits = killWarnings(warned);
        assert.equal(hits.length, 1);
        assert.equal(hits[0], killSwitchTrueWarning(cfg));
      } finally {
        warn.mock.restore();
      }
    });
  });

  it("doctor warns when policy.kill_switch is true", async () => {
    const home = mkdtempSync(join(tmpdir(), "mb-ks-doctor-"));
    const configFile = join(home, "modelbot.yaml");
    const expected = killSwitchTrueWarning(configFile);
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
    assert.equal(
      runSecurityAudit(base).some((c) => c.id === "kill_switch"),
      false,
    );
    const checks = runSecurityAudit({
      ...base,
      killSwitch: true,
      configPath: configFile,
    });
    assert.deepEqual(
      checks.find((c) => c.id === "kill_switch"),
      {
        id: "kill_switch",
        severity: "WARN",
        detail: expected,
      },
    );
    const report = formatDoctorReport(checks);
    assert.ok(report.split("\n").includes(expected));

    writeFileSync(
      join(home, "tokens.json"),
      JSON.stringify({
        mcp_token: "fixture",
        bootstrap_token_hash: "fixture",
      }),
    );
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        data_dir: home,
        policy: { kill_switch: true },
      }),
    );
    const migrated = templateMigrationLines({ policy: { kill_switch: true } })[0];
    let stdout = "";
    const write = mock.method(process.stdout, "write", (chunk: string | Buffer) => {
      stdout += String(chunk);
      return true;
    });
    try {
      const code = await runDoctorCli(["--json"], { home, configFile, containers: [] });
      assert.equal(code, 0);
      const parsed = JSON.parse(stdout) as {
        result: string;
        checks: Array<{ id: string; severity: string; detail: string }>;
      };
      assert.equal(parsed.result, "PASS");
      assert.equal(
        parsed.checks.find((c) => c.id === "kill_switch"),
        undefined,
      );
      assert.deepEqual(
        parsed.checks.find((c) => c.id === "template_migration"),
        {
          id: "template_migration",
          severity: "INFO",
          detail: migrated,
        },
      );

      stdout = "";
      writeFileSync(
        configFile,
        JSON.stringify({
          version: 1,
          config_version: CONFIG_VERSION,
          data_dir: home,
          policy: { kill_switch: true },
        }),
      );
      const armedCode = await runDoctorCli(["--json"], { home, configFile, containers: [] });
      assert.equal(armedCode, 0);
      const armed = JSON.parse(stdout) as {
        result: string;
        checks: Array<{ id: string; severity: string; detail: string }>;
      };
      assert.equal(armed.result, "PASS");
      assert.equal(
        armed.checks.find((c) => c.id === "template_migration"),
        undefined,
      );
      assert.deepEqual(
        armed.checks.find((c) => c.id === "kill_switch"),
        {
          id: "kill_switch",
          severity: "WARN",
          detail: expected,
        },
      );
    } finally {
      write.mock.restore();
    }
  });
});
