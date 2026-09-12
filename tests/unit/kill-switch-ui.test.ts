/**
 * Kill switch in Settings, Home, the task feed, and the live dispatcher.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { FakeComputer, fakeComputerFor } from "../../src/computer-client/fake.ts";
import { createToolDispatcher } from "../../src/daemon/dispatcher.ts";
import { startDaemon } from "../../src/daemon/server.ts";
import { Store } from "../../src/daemon/store.ts";
import { createHomeView } from "../../src/ui/home.ts";
import { currentSession, resetSession } from "../../src/ui/session.ts";
import { feedLine } from "../../src/ui/task.ts";
import { bootstrapSession } from "../helpers/daemon.ts";
import { all, type FakeElement, installDom, settle } from "./ui/fake-dom.ts";

process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";

const KILL_COPY =
  "The kill switch is on, so the bot will refuse every action. Turn it off in Settings → Sensitive actions.";

const json = (body: unknown) => Response.json(body as Record<string, unknown>);
const paneText = (node: FakeElement) =>
  all(node)
    .map((n) => n.textContent)
    .join(" ");

async function clickTool(daemon: Awaited<ReturnType<typeof startDaemon>>, computerId: string) {
  return daemon.callTool(computerId, "browser_click", { snapshot_id: "s1", ref: "e1" });
}

test("GET /api/v1/session returns kill_switch and POST writes false live", async () => {
  const root = mkdtempSync(join(tmpdir(), "mb-kill-ui-"));
  const configPath = join(root, "modelbot.yaml");
  writeFileSync(configPath, "version: 1\npolicy:\n  kill_switch: true\n", { mode: 0o600 });
  const daemon = await startDaemon({
    port: 0,
    mcpToken: "kill-ui-mcp",
    bootstrapToken: "kill-ui-boot",
    workspaceRoot: join(root, "computers"),
    enabledGates: [],
    killSwitch: true,
    idlePauseMin: 0,
    configPath,
  });
  try {
    const session = await bootstrapSession(daemon, "kill-ui-boot");
    const computer = daemon.store.insertComputer({
      id: "kill-ui",
      name: "ks",
      capabilities: ["browser"],
      persistent: false,
      status: "running",
    });

    const read = async () => {
      const res = await fetch(`${daemon.baseUrl}/api/v1/session`, { headers: session.headers });
      assert.equal(res.status, 200);
      return (await res.json()) as { kill_switch?: boolean };
    };
    assert.equal((await read()).kill_switch, true);

    const denied = await clickTool(daemon, computer.id);
    assert.equal((denied as { ok?: boolean }).ok, false);
    assert.equal(
      (denied as { error?: { code?: string; message?: string } }).error?.code,
      "E_POLICY",
    );
    assert.equal((denied as { error?: { message?: string } }).error?.message, "kill_switch");

    const post = await fetch(`${daemon.baseUrl}/api/v1/session`, {
      method: "POST",
      headers: session.headers,
      body: JSON.stringify({ kill_switch: false }),
    });
    assert.equal(post.status, 200);
    assert.equal(((await post.json()) as { kill_switch?: boolean }).kill_switch, false);
    assert.equal((await read()).kill_switch, false);

    const yaml = parseYaml(readFileSync(configPath, "utf8")) as {
      policy?: { kill_switch?: boolean };
    };
    assert.equal(yaml.policy?.kill_switch, false);

    const allowed = await clickTool(daemon, computer.id);
    assert.notEqual((allowed as { error?: { message?: string } }).error?.message, "kill_switch");
  } finally {
    await fakeComputerFor("kill-ui")?.close();
    await daemon.close();
  }
});

test("dispatcher honours a live killSwitch flip on the same options object", async () => {
  const store = new Store();
  const computer = new FakeComputer("ks-live");
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
  const opts = {
    store,
    getClient: () => computer,
    emit: async () => {},
    enabledGates: [],
    killSwitch: true,
  };
  const dispatcher = createToolDispatcher(opts);
  try {
    const denied = await dispatcher.dispatch(
      "browser_click",
      { ref: "e1" },
      { taskId: task.id, computerId: computer.computerId, origin: "https://example.com" },
    );
    assert.equal(denied.ok, false);
    assert.equal(!denied.ok && denied.error.message, "kill_switch");

    opts.killSwitch = false;
    const allowed = await dispatcher.dispatch(
      "browser_click",
      { ref: "e1" },
      { taskId: task.id, computerId: computer.computerId, origin: "https://example.com" },
    );
    assert.notEqual(!allowed.ok && allowed.error.message, "kill_switch");
  } finally {
    await computer.close();
    store.close();
  }
});

test("Sensitive actions kill-switch toggle posts false", async () => {
  resetSession();
  const posts: Array<Record<string, unknown>> = [];
  const state: Record<string, unknown> = {
    ask_before_sensitive: false,
    policy_gates: [],
    kill_switch: true,
    limits: { max_steps: 0, spend_cap_usd: 0 },
  };
  const dom = installDom({
    hash: "#/settings/sensitive",
    fetch: async (path, init) => {
      if (path.startsWith("/api/v1/session/devices")) return json({ devices: [] });
      if (path.startsWith("/api/v1/session")) {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
          posts.push(body);
          if (typeof body.kill_switch === "boolean") state.kill_switch = body.kill_switch;
          return json({ ok: true, csrf: "t", ...state });
        }
        return json({ ok: true, csrf: "t", origin: "https://fixture.example", ...state });
      }
      if (path.startsWith("/api/v1/connection")) {
        return json({ status: "connected", provider: "claude", model: "Opus 4.5" });
      }
      if (path.startsWith("/api/v1/runtime")) {
        return json({
          ai: {
            provider: "claude",
            cli_found: true,
            cli_path_kind: "path",
            logged_in: true,
            detail: "",
          },
        });
      }
      if (path.startsWith("/api/v1/computers"))
        return json({ default_computer_id: null, computers: [] });
      if (path.startsWith("/api/v1/tasks")) return json({ tasks: [] });
      if (path.startsWith("/healthz")) return json({ ok: true, version: "0.4.2" });
      return json({});
    },
  });
  const module = await import(`../../src/ui/settings.ts?kill=${Math.random()}`);
  assert.equal(((await currentSession()) as { kill_switch?: boolean } | null)?.kill_switch, true);
  const view = module.createSettingsView();
  view.mount(dom.root as never, { section: "sensitive" });
  await settle();
  await settle();
  const pane = dom.root.querySelector(".set-pane") as FakeElement;
  try {
    assert.match(paneText(pane), /Stop the bot from taking any action \(kill switch\)/);
    assert.match(
      paneText(pane),
      /When this is on, every tool call is refused until you turn it off/,
    );
    const box = pane.querySelector("input[data-kill-switch]") as FakeElement;
    assert.equal(box.checked, true);
    box.checked = false;
    box.fire("change");
    await settle();
    await settle();
    assert.deepEqual(posts[0], { kill_switch: false });
    assert.equal(box.checked, false);
    assert.match(paneText(pane), /Off\. The bot can take actions again/);
    assert.equal(
      ((await currentSession()) as { kill_switch?: boolean } | null)?.kill_switch,
      false,
    );
  } finally {
    view.unmount();
    dom.restore();
    resetSession();
  }
});

test("Home kill-switch banner renders only when true", async () => {
  const IMAGE = { present: true, created_at: "2026-09-01T00:00:00Z", stale: false };
  const runtime = {
    node: { ok: true, version: "22.18.0" },
    docker: { installed: true, running: true, engine: "orbstack", version: "1.0" },
    images: {
      computer: { ...IMAGE },
      shell: { ...IMAGE },
      proxy: { ...IMAGE },
      prepare: { state: "idle", step: "", percent: null, log_tail: [], error: null },
    },
    ai: {
      provider: "claude",
      cli_found: true,
      cli_path_kind: "path",
      logged_in: true,
      detail: "Signed in",
    },
    task_start_available: true,
    blockers: [],
  };

  async function mount(kill_switch: boolean) {
    resetSession();
    const dom = installDom({
      fetch: async (path) => {
        if (path === "/api/v1/session") {
          return json({
            ok: true,
            csrf: "t",
            model: "claude-opus-4-5",
            execution_mode: "claude",
            kill_switch,
          });
        }
        if (path === "/api/v1/runtime") return json(runtime);
        if (path === "/api/v1/models") {
          return json({
            providers: [
              {
                id: "claude",
                label: "Claude",
                default_model: "claude-fable-5-1",
                connected: true,
                start_available: true,
                models: [{ id: "claude-fable-5-1", label: "Fable 5.1" }],
              },
            ],
          });
        }
        if (path === "/api/v1/tasks") return json({ tasks: [] });
        if (path === "/api/v1/takeovers") return json({ takeovers: [] });
        if (path === "/api/v1/computers") {
          return json({ default_computer_id: null, max_computers: 2, computers: [] });
        }
        return json({});
      },
    });
    const view = createHomeView({ activeMs: 2, hiddenMs: 4 });
    view.mount(dom.root as unknown as HTMLElement);
    await settle(8);
    return { dom, view };
  }

  const on = await mount(true);
  try {
    const banner = on.dom.find(".home-kill-switch");
    assert.ok(banner, "banner is on Home while the kill switch is on");
    assert.match(banner!.textContent, new RegExp(KILL_COPY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const link = banner!.querySelector("a")!;
    assert.equal(link.getAttribute("href"), "#/settings/sensitive");
    assert.equal(link.textContent, "Settings → Sensitive actions");
  } finally {
    on.view.unmount();
    on.dom.restore();
  }

  const off = await mount(false);
  try {
    assert.equal(off.dom.find(".home-kill-switch"), null);
    assert.doesNotMatch(off.dom.root.textContent, /kill switch is on/);
  } finally {
    off.view.unmount();
    off.dom.restore();
  }
});

test("Home banner uses a fresh session GET, not the bootstrap cache", async () => {
  resetSession();
  let kill_switch = false;
  const IMAGE = { present: true, created_at: "2026-09-01T00:00:00Z", stale: false };
  const runtime = {
    node: { ok: true, version: "22.18.0" },
    docker: { installed: true, running: true, engine: "orbstack", version: "1.0" },
    images: {
      computer: { ...IMAGE },
      shell: { ...IMAGE },
      proxy: { ...IMAGE },
      prepare: { state: "idle", step: "", percent: null, log_tail: [], error: null },
    },
    ai: {
      provider: "claude",
      cli_found: true,
      cli_path_kind: "path",
      logged_in: true,
      detail: "Signed in",
    },
    task_start_available: true,
    blockers: [],
  };
  const dom = installDom({
    fetch: async (path) => {
      if (path === "/api/v1/session") {
        return json({
          ok: true,
          csrf: "t",
          model: "claude-opus-4-5",
          execution_mode: "claude",
          kill_switch,
        });
      }
      if (path === "/api/v1/runtime") return json(runtime);
      if (path === "/api/v1/models") {
        return json({
          providers: [
            {
              id: "claude",
              label: "Claude",
              default_model: "claude-fable-5-1",
              connected: true,
              start_available: true,
              models: [{ id: "claude-fable-5-1", label: "Fable 5.1" }],
            },
          ],
        });
      }
      if (path === "/api/v1/tasks") return json({ tasks: [] });
      if (path === "/api/v1/takeovers") return json({ takeovers: [] });
      if (path === "/api/v1/computers") {
        return json({ default_computer_id: null, max_computers: 2, computers: [] });
      }
      return json({});
    },
  });
  const view = createHomeView({ activeMs: 2, hiddenMs: 4 });
  try {
    assert.equal(
      ((await currentSession()) as { kill_switch?: boolean } | null)?.kill_switch,
      false,
    );
    kill_switch = true;
    view.mount(dom.root as unknown as HTMLElement);
    await settle(8);
    const banner = dom.find(".home-kill-switch");
    assert.ok(banner, "banner appears after remount when the live session is on");
    assert.match(banner!.textContent, new RegExp(KILL_COPY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    view.unmount();
    dom.restore();
    resetSession();
  }
});

test("task feed names the kill switch when a tool is denied for that reason", () => {
  const denied = feedLine("policy.denied", { tool: "browser_navigate", reason: "kill_switch" });
  assert.equal(denied?.text, KILL_COPY);
  const other = feedLine("policy.denied", { tool: "browser_navigate", reason: "tos_block" });
  assert.notEqual(other?.text, KILL_COPY);
  const error = feedLine("tool.error", {
    name: "browser_navigate",
    result: { ok: false, error: { code: "E_POLICY", message: "kill_switch" } },
  });
  assert.equal(error, null);
});
