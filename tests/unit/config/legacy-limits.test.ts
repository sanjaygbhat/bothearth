/**
 * Legacy template keys must not pin values the product later raised, and a
 * running computer must pick up sandbox memory / shm without a recreate when
 * Docker can update memory in place.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { parse as parseYaml } from "yaml";
import { runDoctorCli } from "../../../src/cli/doctor.ts";
import { runInit } from "../../../src/cli/init.ts";
import { configPath } from "../../../src/cli/paths.ts";
import { createFakeSandbox } from "../../../src/computer-client/fake-sandbox.ts";
import {
  CONFIG_VERSION,
  loadModelbotSchema,
  templateMigrationLines,
  validateModelbotConfig,
  withDefaults,
  writePolicyGates,
} from "../../../src/config/load.ts";
import { startDaemon } from "../../../src/daemon/server.ts";
import { Store } from "../../../src/daemon/store.ts";
import type { DockerCli } from "../../../src/sandbox/docker.ts";
import { DEFAULT_LIMITS, parseDockerMemoryBytes } from "../../../src/sandbox/flags.ts";
import { defaultSeccompPath, reconcileComputerLimits } from "../../../src/sandbox/lifecycle.ts";
import { assertValid } from "../../../src/schema/validate.ts";
import { until } from "../../helpers/until.ts";

process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";

const GIB = 1024 ** 3;
const LINE = {
  kill_switch:
    "policy.kill_switch: true came from an old template; ignoring it — set it again in Settings if you want it",
  memory:
    "sandbox.memory: 2g came from an old template; ignoring it — set it again in Settings if you want it",
  shm_size:
    "sandbox.shm_size: 1g came from an old template; ignoring it — set it again in Settings if you want it",
  image_browser:
    "sandbox.image_browser: modelbot/browser:dev came from an old template; ignoring it — set it again in Settings if you want it",
} as const;

const LEGACY_YAML = [
  "policy:",
  "  kill_switch: true",
  "sandbox:",
  "  memory: 2g",
  "  shm_size: 1g",
  "  image_browser: modelbot/browser:dev",
  "",
].join("\n");

const runtime = { kind: "docker", binary: "docker" } as const;

function limitCli(host: { memory: number; shm: number }, opts: { recreate?: boolean } = {}) {
  const seen: string[][] = [];
  const cli: DockerCli & { seen: string[][] } = {
    binary: "docker",
    seen,
    async run(args: string[]) {
      seen.push(args);
      if (args[0] === "inspect" && !args.includes("-f")) {
        return JSON.stringify([
          {
            HostConfig: {
              Memory: host.memory,
              ShmSize: host.shm,
              SecurityOpt: ["seccomp=/sandbox/seccomp-chromium.json"],
            },
          },
        ]);
      }
      if (args[0] === "update") return "";
      if (
        opts.recreate &&
        ["create", "rm", "start", "unpause", "network", "volume"].includes(args[0]!)
      ) {
        return "";
      }
      throw new Error(`Error: No such object: ${args.at(-1)}`);
    },
    runSync: () => "",
    spawn: (() => {
      throw new Error("not used");
    }) as never,
  };
  return cli;
}

describe("legacy template migration", () => {
  it("treats each old template key as unset when config_version is absent", () => {
    const kill = withDefaults({ policy: { kill_switch: true } }) as {
      policy: { kill_switch: boolean };
    };
    assert.equal(kill.policy.kill_switch, false);
    assert.equal(templateMigrationLines({ policy: { kill_switch: true } })[0], LINE.kill_switch);

    const mem = withDefaults({ sandbox: { memory: "2g" } }) as { sandbox: { memory: string } };
    assert.equal(mem.sandbox.memory, "4g");
    assert.equal(templateMigrationLines({ sandbox: { memory: "2g" } })[0], LINE.memory);

    const shm = withDefaults({ sandbox: { shm_size: "1g" } }) as { sandbox: { shm_size: string } };
    assert.equal(shm.sandbox.shm_size, "2g");
    assert.equal(templateMigrationLines({ sandbox: { shm_size: "1g" } })[0], LINE.shm_size);

    const image = withDefaults({ sandbox: { image_browser: "modelbot/browser:dev" } }) as {
      sandbox: { image_browser: string };
    };
    assert.equal(image.sandbox.image_browser, "modelbot/computer:dev");
    assert.equal(
      templateMigrationLines({ sandbox: { image_browser: "modelbot/browser:dev" } })[0],
      LINE.image_browser,
    );
  });

  it("honours the same keys when config_version is present", () => {
    const schema = loadModelbotSchema();
    const cfg = validateModelbotConfig(
      {
        config_version: CONFIG_VERSION,
        policy: { kill_switch: true },
        sandbox: {
          memory: "2g",
          shm_size: "1g",
          image_browser: "modelbot/browser:dev",
        },
      },
      schema,
    );
    assert.equal(cfg.policy.kill_switch, true);
    assert.equal((cfg as { config_version?: unknown }).config_version, CONFIG_VERSION);
    assert.equal(cfg.sandbox.memory, "2g");
    assert.equal(cfg.sandbox.shm_size, "1g");
    assert.equal(cfg.sandbox.image_browser, "modelbot/browser:dev");
    assert.deepEqual(
      templateMigrationLines({
        config_version: CONFIG_VERSION,
        policy: { kill_switch: true },
        sandbox: { memory: "2g", shm_size: "1g", image_browser: "modelbot/browser:dev" },
      }),
      [],
    );
  });

  it("init writes config_version", async () => {
    const home = mkdtempSync(join(tmpdir(), "mb-legacy-init-"));
    const previous = process.env.MODELBOT_VAULT_KEY_HEX;
    process.env.MODELBOT_VAULT_KEY_HEX = Buffer.alloc(32, 7).toString("hex");
    try {
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
      const raw = parseYaml(readFileSync(configPath(home), "utf8")) as {
        config_version?: unknown;
      };
      assert.equal(raw.config_version, CONFIG_VERSION);
      assertValid(loadModelbotSchema(), raw);
    } finally {
      if (previous === undefined) delete process.env.MODELBOT_VAULT_KEY_HEX;
      else process.env.MODELBOT_VAULT_KEY_HEX = previous;
    }
  });

  it("writePolicyGates migrates old template keys before stamping config_version", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mb-legacy-gates-")), "modelbot.yaml");
    writeFileSync(path, LEGACY_YAML, { mode: 0o600 });
    writePolicyGates(path, { spend_cap_usd: 5 });
    const afterCap = parseYaml(readFileSync(path, "utf8")) as {
      config_version?: unknown;
      policy?: { kill_switch?: unknown };
      sandbox?: { memory?: unknown; shm_size?: unknown; image_browser?: unknown };
      agent?: { spend_cap_usd?: unknown };
    };
    assert.equal(afterCap.config_version, CONFIG_VERSION);
    assert.equal(afterCap.policy?.kill_switch, undefined);
    assert.equal(afterCap.sandbox?.memory, undefined);
    assert.equal(afterCap.sandbox?.shm_size, undefined);
    assert.equal(afterCap.sandbox?.image_browser, undefined);
    assert.equal(afterCap.agent?.spend_cap_usd, 5);
    const loaded = validateModelbotConfig(afterCap, loadModelbotSchema());
    assert.equal(loaded.policy.kill_switch, false);
    assert.equal(loaded.sandbox.memory, "4g");
    assert.equal(loaded.sandbox.shm_size, "2g");
    assert.equal(loaded.sandbox.image_browser, "modelbot/computer:dev");

    writeFileSync(path, LEGACY_YAML, { mode: 0o600 });
    writePolicyGates(path, { kill_switch: true });
    const armed = parseYaml(readFileSync(path, "utf8")) as {
      config_version?: unknown;
      policy?: { kill_switch?: unknown };
    };
    assert.equal(armed.config_version, CONFIG_VERSION);
    assert.equal(armed.policy?.kill_switch, true);
  });

  it("doctor prints the same migration lines", async () => {
    const home = mkdtempSync(join(tmpdir(), "mb-legacy-doctor-"));
    const configFile = join(home, "modelbot.yaml");
    writeFileSync(
      join(home, "tokens.json"),
      JSON.stringify({
        mcp_token: "fixture",
        bootstrap_token_hash: "fixture",
      }),
    );
    writeFileSync(configFile, LEGACY_YAML);
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
        parsed.checks
          .filter((c) => c.id === "template_migration")
          .map((c) => c.detail)
          .sort(),
        Object.values(LINE).slice().sort(),
      );
    } finally {
      write.mock.restore();
    }
  });
});

describe("computer limit drift", () => {
  it("memory drift runs docker update argv in place", async () => {
    const c = limitCli({
      memory: 2 * GIB,
      shm: parseDockerMemoryBytes(DEFAULT_LIMITS.browserShm)!,
    });
    const result = await reconcileComputerLimits("mine", ["browser"], {
      runtime,
      cli: c,
      workspaceRoot: mkdtempSync(join(tmpdir(), "mb-limit-mem-")),
      seccompPath: defaultSeccompPath(),
    });
    assert.equal(result, "updated");
    assert.deepEqual(
      c.seen.find((a) => a[0] === "update"),
      ["update", "--memory", "4g", "--memory-swap", "4g", "modelbot-mine-browser"],
    );
    assert.equal(
      c.seen.some((a) => a[0] === "rm"),
      false,
    );
    assert.equal(
      c.seen.some((a) => a[0] === "create"),
      false,
    );
  });

  it("shm drift recreates only when idle", async () => {
    const idle = limitCli(
      { memory: parseDockerMemoryBytes(DEFAULT_LIMITS.browserMemory)!, shm: 1 * GIB },
      { recreate: true },
    );
    const idleRoot = mkdtempSync(join(tmpdir(), "mb-limit-shm-idle-"));
    assert.equal(
      await reconcileComputerLimits("mine", ["browser"], {
        runtime,
        cli: idle,
        allowRecreate: true,
        workspaceRoot: idleRoot,
        seccompPath: defaultSeccompPath(),
      }),
      "recreated",
    );
    assert.ok(idle.seen.some((a) => a[0] === "unpause"));
    assert.ok(idle.seen.some((a) => a[0] === "rm" && a.includes("modelbot-mine-browser")));
    assert.ok(idle.seen.some((a) => a[0] === "create" && a.includes("modelbot-mine-browser")));

    const busy = limitCli({
      memory: parseDockerMemoryBytes(DEFAULT_LIMITS.browserMemory)!,
      shm: 1 * GIB,
    });
    assert.equal(
      await reconcileComputerLimits("mine", ["browser"], {
        runtime,
        cli: busy,
        allowRecreate: false,
        workspaceRoot: mkdtempSync(join(tmpdir(), "mb-limit-shm-busy-")),
        seccompPath: defaultSeccompPath(),
      }),
      false,
    );
    assert.equal(
      busy.seen.some((a) => a[0] === "update"),
      false,
    );
    assert.equal(
      busy.seen.some((a) => a[0] === "rm"),
      false,
    );
    assert.equal(
      busy.seen.some((a) => a[0] === "create"),
      false,
    );
  });

  it("boot reconcile asks for recreate only when the computer is idle", async () => {
    const root = mkdtempSync(join(tmpdir(), "mb-limit-boot-"));
    const sqlitePath = join(root, "state.sqlite");
    const seed = new Store(sqlitePath);
    seed.insertComputer({
      id: "browser-busy",
      name: "Busy",
      capabilities: ["browser"],
      persistent: true,
      status: "running",
    });
    seed.insertComputer({
      id: "browser-idle",
      name: "Idle",
      capabilities: ["browser"],
      persistent: true,
      status: "running",
    });
    seed.insertTask({ computer_id: "browser-busy", goal: "Keep going", max_steps: 5 });
    seed.close();
    const sandbox = createFakeSandbox({ workspaceRoot: root }) as ReturnType<
      typeof createFakeSandbox
    > & {
      reconcileLimits: (
        computerId: string,
        capabilities: string[],
        opts: { allowRecreate: boolean },
      ) => Promise<"updated" | "recreated" | false>;
    };
    const calls: Array<{ id: string; allowRecreate: boolean }> = [];
    sandbox.reconcileLimits = async (id, _caps, { allowRecreate }) => {
      calls.push({ id, allowRecreate });
      return "updated";
    };
    const daemon = await startDaemon({
      port: 0,
      sqlitePath,
      workspaceRoot: root,
      sandbox,
      bootstrapToken: "limit-boot",
      mcpToken: "limit-boot-mcp",
      nativeExecutionLocation: "computer",
    });
    try {
      await until(() => calls.length >= 2, "boot never reconciled computer limits");
      assert.equal(calls.find((c) => c.id === "browser-busy")?.allowRecreate, false);
      assert.equal(calls.find((c) => c.id === "browser-idle")?.allowRecreate, true);
    } finally {
      await daemon.close();
    }
  });
});
