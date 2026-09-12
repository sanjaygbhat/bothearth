import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { parse as parseYaml } from "yaml";
import { startDaemon } from "../../../src/daemon/server.ts";
import { OPTIONAL_POLICY_GATES, type PolicyGate } from "../../../src/types/contracts.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";

process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";

test("omitted enabledGates arms no optional approvals", async () => {
  const root = mkdtempSync(join(tmpdir(), "mb-gates-omit-"));
  const daemon = await startDaemon({
    port: 0,
    mcpToken: "omit-gates-mcp",
    bootstrapToken: "omit-gates-boot",
    workspaceRoot: join(root, "computers"),
  });
  try {
    const session = await bootstrapSession(daemon, "omit-gates-boot");
    const res = await fetch(`${daemon.baseUrl}/api/v1/session`, { headers: session.headers });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { ask_before_sensitive?: boolean }).ask_before_sensitive, false);
    const computer = daemon.store.insertComputer({
      id: "omit-gates",
      name: "omit",
      capabilities: ["browser"],
      persistent: false,
      status: "running",
    });
    const upload = await daemon.callTool(computer.id, "browser_upload", {
      snapshot_id: "s1",
      ref: "e1",
      paths: ["/workspace/a.txt"],
    });
    assert.equal((upload as { ok?: boolean }).ok, true);
  } finally {
    await daemon.close();
  }
});

test("ask-before-sensitive toggle round-trips through session and yaml", async () => {
  const root = mkdtempSync(join(tmpdir(), "mb-sensitive-"));
  const configPath = join(root, "modelbot.yaml");
  writeFileSync(configPath, "version: 1\n", { mode: 0o600 });
  const daemon = await startDaemon({
    port: 0,
    mcpToken: "sensitive-mcp",
    bootstrapToken: "sensitive-boot",
    workspaceRoot: join(root, "computers"),
    enabledGates: [],
    configPath,
  });
  try {
    const session = await bootstrapSession(daemon, "sensitive-boot");
    const read = async () => {
      const res = await fetch(`${daemon.baseUrl}/api/v1/session`, { headers: session.headers });
      assert.equal(res.status, 200);
      return (await res.json()) as { ask_before_sensitive?: boolean };
    };
    const write = async (on: boolean) => {
      const res = await fetch(`${daemon.baseUrl}/api/v1/session`, {
        method: "POST",
        headers: session.headers,
        body: JSON.stringify({ ask_before_sensitive: on }),
      });
      assert.equal(res.status, 200);
      return (await res.json()) as { ask_before_sensitive?: boolean };
    };

    assert.equal((await read()).ask_before_sensitive, false);
    assert.equal((await write(true)).ask_before_sensitive, true);
    assert.equal((await read()).ask_before_sensitive, true);
    const onDoc = parseYaml(readFileSync(configPath, "utf8")) as { policy?: { gates?: string[] } };
    assert.deepEqual(onDoc.policy?.gates, [...OPTIONAL_POLICY_GATES]);

    assert.equal((await write(false)).ask_before_sensitive, false);
    assert.equal((await read()).ask_before_sensitive, false);
    const offDoc = parseYaml(readFileSync(configPath, "utf8")) as { policy?: { gates?: string[] } };
    assert.deepEqual(offDoc.policy?.gates, []);
  } finally {
    await daemon.close();
  }
});

test("session round-trip persists a gate subset and API-adapter limits", async () => {
  const root = mkdtempSync(join(tmpdir(), "mb-sensitive-limits-"));
  const configPath = join(root, "modelbot.yaml");
  writeFileSync(configPath, "version: 1\nbind: 127.0.0.1\n", { mode: 0o600 });
  const daemon = await startDaemon({
    port: 0,
    mcpToken: "limits-mcp",
    bootstrapToken: "limits-boot",
    workspaceRoot: join(root, "computers"),
    enabledGates: [],
    configPath,
  });
  try {
    const session = await bootstrapSession(daemon, "limits-boot");
    const post = async (body: Record<string, unknown>) => {
      const res = await fetch(`${daemon.baseUrl}/api/v1/session`, {
        method: "POST",
        headers: session.headers,
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 200, await res.clone().text());
      return (await res.json()) as {
        ask_before_sensitive: boolean;
        policy_gates: string[];
        limits: { max_steps: number; spend_cap_usd: number };
      };
    };
    const read = async () => {
      const res = await fetch(`${daemon.baseUrl}/api/v1/session`, { headers: session.headers });
      assert.equal(res.status, 200);
      return (await res.json()) as {
        ask_before_sensitive: boolean;
        policy_gates: string[];
        limits: { max_steps: number; spend_cap_usd: number };
      };
    };

    const subset = await post({
      ask_before_sensitive: true,
      policy_gates: ["payment", "upload", "payment"],
    });
    assert.equal(subset.ask_before_sensitive, true);
    assert.deepEqual(subset.policy_gates, ["payment", "upload"]);
    assert.deepEqual((await read()).policy_gates, ["payment", "upload"]);

    const limits = await post({ max_steps: 0, spend_cap_usd: 7.5 });
    assert.deepEqual(limits.policy_gates, ["payment", "upload"]);
    assert.deepEqual(limits.limits, { max_steps: 0, spend_cap_usd: 7.5 });
    assert.deepEqual((await read()).limits, { max_steps: 0, spend_cap_usd: 7.5 });

    const yaml = parseYaml(readFileSync(configPath, "utf8")) as {
      bind: string;
      policy: { gates: string[] };
      agent: { max_steps: number; spend_cap_usd: number };
    };
    assert.equal(yaml.bind, "127.0.0.1");
    assert.deepEqual(yaml.policy.gates, ["payment", "upload"]);
    assert.equal(yaml.agent.max_steps, 0);
    assert.equal(yaml.agent.spend_cap_usd, 7.5);
  } finally {
    await daemon.close();
  }
});

test("boot logs armed policy.gates only when the configured list is non-empty", async () => {
  const cases: Array<{ enabledGates?: PolicyGate[]; expectLog: boolean }> = [
    { enabledGates: undefined, expectLog: false },
    { enabledGates: [], expectLog: false },
    { enabledGates: ["external_send", "payment"], expectLog: true },
  ];
  for (const { enabledGates, expectLog } of cases) {
    const root = mkdtempSync(join(tmpdir(), "mb-gates-boot-"));
    const lines: string[] = [];
    const log = mock.method(console, "log", (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    try {
      const daemon = await startDaemon({
        port: 0,
        mcpToken: "gates-mcp",
        bootstrapToken: "gates-boot",
        workspaceRoot: join(root, "computers"),
        ...(enabledGates !== undefined ? { enabledGates } : {}),
      });
      await daemon.close();
      const armed = lines.flatMap((line) => {
        try {
          const row = JSON.parse(line) as { msg?: string; gates?: string[]; level?: string };
          return row.msg === "policy.gates armed" ? [row] : [];
        } catch {
          return [];
        }
      });
      if (expectLog) {
        assert.equal(armed.length, 1);
        assert.equal(armed[0]!.level, "info");
        assert.deepEqual(armed[0]!.gates, enabledGates);
      } else {
        assert.equal(armed.length, 0);
      }
    } finally {
      log.mock.restore();
    }
  }
});
