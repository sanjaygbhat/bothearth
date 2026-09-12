import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createState,
  dispatch,
  SUPPORTED_METHODS,
  uniqueCookieHosts,
} from "../../computer-server/src/dispatch.ts";
import { FakeComputer } from "../../src/computer-client/fake.ts";
import { createFakeSandbox } from "../../src/computer-client/fake-sandbox.ts";
import { signedInSiteDomains, startDaemon } from "../../src/daemon/server.ts";
import type { DockerCli } from "../../src/sandbox/docker.ts";
import { destroyComputer, forgetComputerLogins } from "../../src/sandbox/lifecycle.ts";
import { resourceNames } from "../../src/sandbox/names.ts";
import { TOOL_NAMES } from "../../src/types/contracts.ts";
import { bootstrapSession } from "../helpers/daemon.ts";

process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";
process.env.MODELBOT_NO_OPEN = "1";
process.env.CI = "1";

test("uniqueCookieHosts keeps host names and drops values", () => {
  assert.ok(SUPPORTED_METHODS.includes("profile.signed-in"));
  assert.equal((TOOL_NAMES as readonly string[]).includes("profile.signed-in"), false);
  const hosts = uniqueCookieHosts([
    { domain: ".www.google.com" },
    { domain: "chat.openai.com" },
    { domain: ".google.com" },
    { domain: "www.google.com" },
  ]);
  assert.deepEqual(hosts, ["chat.openai.com", "google.com", "www.google.com"]);
  const leaked = uniqueCookieHosts([
    { domain: ".chatgpt.com", name: "session", value: "SECRET_COOKIE_VALUE" } as {
      domain?: string;
    },
  ]);
  assert.deepEqual(leaked, ["chatgpt.com"]);
  assert.equal(JSON.stringify(leaked).includes("SECRET_COOKIE_VALUE"), false);
});

test("profile.signed-in returns hosts only, never cookie values", async () => {
  const state = createState("browser");
  state.browser = {
    context: {
      cookies: async () => [
        { domain: ".accounts.google.com", name: "SID", value: "SECRET_COOKIE_VALUE" },
        { domain: "chatgpt.com", name: "session", value: "OTHER_SECRET" },
      ],
    },
  } as never;
  const result = await dispatch(state, { jsonrpc: "2.0", id: 1, method: "profile.signed-in" });
  assert.equal(result.ok, true);
  const body = JSON.stringify(result);
  assert.equal(body.includes("SECRET_COOKIE_VALUE"), false);
  assert.equal(body.includes("OTHER_SECRET"), false);
  assert.equal(body.includes("SID"), false);
  assert.deepEqual((result as { data: { hosts: string[] } }).data.hosts, [
    "accounts.google.com",
    "chatgpt.com",
  ]);
});

test("profile.signed-in does not launch Chromium on a cold session", async () => {
  const state = createState("browser");
  assert.equal(state.browser, null);
  const result = await dispatch(state, { jsonrpc: "2.0", id: 1, method: "profile.signed-in" });
  assert.equal(result.ok, true);
  assert.deepEqual((result as { data: { hosts: string[] } }).data.hosts, []);
  assert.equal(state.browser, null);
});

test("signedInSiteDomains maps hosts to eTLD+1 and rejects cookie-shaped strings", () => {
  assert.deepEqual(
    signedInSiteDomains(["www.google.com", "accounts.google.com", ".chat.openai.com"]),
    ["google.com", "openai.com"],
  );
  assert.deepEqual(signedInSiteDomains(["SID=SECRET_COOKIE_VALUE", "chatgpt.com"]), [
    "chatgpt.com",
  ]);
});

describe("destroyComputer keepProfile", () => {
  const runtime = { kind: "docker" as const, binary: "docker" };

  function recordingCli(): { cli: DockerCli; calls: string[][] } {
    const calls: string[][] = [];
    const cli: DockerCli = {
      binary: "docker",
      async run(args) {
        calls.push(args);
        if (args[0] === "inspect" && !args.includes("-f")) {
          return JSON.stringify([{ HostConfig: { SecurityOpt: ["seccomp=/opt/seccomp"] } }]);
        }
        return "";
      },
      runSync() {
        throw new Error("runSync unused");
      },
      spawn() {
        throw new Error("spawn unused");
      },
    };
    return { cli, calls };
  }

  it("default destroy keeps the profile and agent-home volumes", async () => {
    const { cli, calls } = recordingCli();
    await destroyComputer("demo", {}, { cli, runtime });
    const lines = calls.map((args) => args.join(" "));
    assert.equal(
      lines.some((line) => line.includes("volume rm")),
      false,
    );
    assert.ok(lines.some((line) => line === `rm -f ${resourceNames("demo").containerBrowser}`));
  });

  it("keepProfile false removes only the profile volume", async () => {
    const { cli, calls } = recordingCli();
    await destroyComputer("demo", { keepProfile: false }, { cli, runtime });
    const lines = calls.map((args) => args.join(" "));
    const names = resourceNames("demo");
    assert.ok(lines.includes(`volume rm ${names.volumeProfile}`));
    assert.equal(lines.includes(`volume rm ${names.volumeAgentHome}`), false);
  });

  it("forgetComputerLogins removes only the profile volume and recreates containers", async () => {
    const { cli, calls } = recordingCli();
    const root = mkdtempSync(join(tmpdir(), "mb-forget-life-"));
    await forgetComputerLogins(
      "demo",
      { capabilities: ["browser"] },
      { cli, runtime, workspaceRoot: root },
    );
    const lines = calls.map((args) => args.join(" "));
    const names = resourceNames("demo");
    assert.ok(lines.includes(`volume rm ${names.volumeProfile}`));
    assert.equal(lines.includes(`volume rm ${names.volumeAgentHome}`), false);
    const rmProfile = lines.indexOf(`volume rm ${names.volumeProfile}`);
    assert.ok(
      lines.slice(rmProfile + 1).some((line) => line.includes(`--name ${names.containerBrowser}`)),
    );
    assert.ok(
      lines.some((line) => line.includes("volume create") && line.includes(names.volumeAgentHome)),
    );
  });
});

async function daemonFixture(opts?: { forgetLogins?: (id: string) => Promise<void> }) {
  const root = mkdtempSync(join(tmpdir(), "mb-forget-logins-"));
  const sandbox = createFakeSandbox({ workspaceRoot: root });
  const forgotten: string[] = [];
  const daemon = await startDaemon({
    port: 0,
    workspaceRoot: root,
    sandbox: Object.assign(sandbox, {
      forgetLogins: async (id: string) => {
        forgotten.push(id);
        await opts?.forgetLogins?.(id);
      },
    }),
    bootstrapToken: "forget-boot",
    mcpToken: "forget-mcp",
    agentLoop: {
      model: "synthetic",
      adapter: {
        kind: "openai_compat",
        complete: (request) =>
          new Promise((_, reject) => {
            if (request.signal?.aborted) reject(new Error("cancelled"));
            else
              request.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
                once: true,
              });
          }),
      },
    },
  });
  const { headers } = await bootstrapSession(daemon, "forget-boot");
  const api = async (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await fetch(`${daemon.baseUrl}${path}`, {
      headers,
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return {
    daemon,
    api,
    forgotten,
    sandbox,
    async close() {
      await daemon.close();
    },
  };
}

test("GET signed-in is operator-only and returns domains", async () => {
  const f = await daemonFixture();
  try {
    const created = await f.api("/api/v1/computers", { name: "Logins", capabilities: ["browser"] });
    const id = (created.body.computer as { id: string }).id;
    const listed = await f.api(`/api/v1/computers/${id}/signed-in`);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, { domains: [] });
    const missing = await f.api("/api/v1/computers/no-such/signed-in");
    assert.equal(missing.status, 404);
    const unauth = await fetch(`${f.daemon.baseUrl}/api/v1/computers/${id}/signed-in`);
    assert.equal(unauth.status, 401);
  } finally {
    await f.close();
  }
});

test("GET signed-in inspects a browser-only computer with its capabilities", async () => {
  const orig = FakeComputer.prototype.call;
  FakeComputer.prototype.call = async function (method, params) {
    if (method === "profile.signed-in") {
      return { ok: true, data: { hosts: ["www.google.com"] } };
    }
    return orig.call(this, method, params);
  };
  const f = await daemonFixture();
  const seen: Array<string[] | undefined> = [];
  const inner = f.sandbox.inspectStatus.bind(f.sandbox);
  f.sandbox.inspectStatus = async (id, capabilities) => {
    seen.push(capabilities);
    const caps = capabilities ?? ["browser", "shell"];
    if (caps.includes("shell")) return "stopped";
    return inner(id);
  };
  try {
    const created = await f.api("/api/v1/computers", {
      name: "Browser",
      capabilities: ["browser"],
    });
    const id = (created.body.computer as { id: string }).id;
    const listed = await f.api(`/api/v1/computers/${id}/signed-in`);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, { domains: ["google.com"] });
    assert.deepEqual(seen, [["browser"]]);
  } finally {
    FakeComputer.prototype.call = orig;
    await f.close();
  }
});

test("GET signed-in maps hosts on a running computer and skips a paused one", async () => {
  const orig = FakeComputer.prototype.call;
  const seen: string[] = [];
  FakeComputer.prototype.call = async function (method, params) {
    if (method === "profile.signed-in") {
      seen.push(this.computerId);
      return { ok: true, data: { hosts: ["www.google.com"] } };
    }
    return orig.call(this, method, params);
  };
  const f = await daemonFixture();
  try {
    const created = await f.api("/api/v1/computers", { name: "Logins", capabilities: ["browser"] });
    const id = (created.body.computer as { id: string }).id;
    const listed = await f.api(`/api/v1/computers/${id}/signed-in`);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, { domains: ["google.com"] });
    assert.deepEqual(seen, [id]);
    const rec = f.sandbox.get(id);
    assert.ok(rec);
    rec.status = "paused";
    seen.length = 0;
    const paused = await f.api(`/api/v1/computers/${id}/signed-in`);
    assert.equal(paused.status, 200);
    assert.deepEqual(paused.body, { domains: [] });
    assert.deepEqual(seen, []);
    assert.equal(rec.status, "paused");
  } finally {
    FakeComputer.prototype.call = orig;
    await f.close();
  }
});

test("POST forget-logins refuses a running task", async () => {
  const f = await daemonFixture();
  try {
    const created = await f.api("/api/v1/computers", { name: "Busy", capabilities: ["browser"] });
    const id = (created.body.computer as { id: string }).id;
    f.daemon.store.insertTask({ computer_id: id, goal: "Read mail", max_steps: 5 });
    const refused = await f.api(`/api/v1/computers/${id}/forget-logins`, {});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, "E_TASK_ACTIVE");
    assert.match(String(refused.body.message), /task in progress/i);
    assert.deepEqual(f.forgotten, []);
  } finally {
    await f.close();
  }
});

test("POST forget-logins refuses a paused task", async () => {
  const f = await daemonFixture();
  try {
    const created = await f.api("/api/v1/computers", { name: "Paused", capabilities: ["browser"] });
    const id = (created.body.computer as { id: string }).id;
    const task = f.daemon.store.insertTask({ computer_id: id, goal: "Read mail", max_steps: 5 });
    assert.equal(f.daemon.store.pauseTask(task.id), true);
    const refused = await f.api(`/api/v1/computers/${id}/forget-logins`, {});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, "E_TASK_ACTIVE");
    assert.match(String(refused.body.message), /task in progress/i);
    assert.deepEqual(f.forgotten, []);
  } finally {
    await f.close();
  }
});

test("POST forget-logins refuses an open takeover hold", async () => {
  const f = await daemonFixture();
  try {
    const created = await f.api("/api/v1/computers", { name: "Held", capabilities: ["browser"] });
    const id = (created.body.computer as { id: string }).id;
    f.daemon.store.insertTakeover({
      id: "tk_forget",
      computer_id: id,
      task_id: null,
      state: "human",
      expires_at: null,
    });
    const refused = await f.api(`/api/v1/computers/${id}/forget-logins`, {});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, "E_STATE");
    assert.match(String(refused.body.message), /Take control/);
    assert.deepEqual(f.forgotten, []);
  } finally {
    await f.close();
  }
});

test("POST forget-logins recreates when idle", async () => {
  const f = await daemonFixture();
  try {
    const created = await f.api("/api/v1/computers", { name: "Idle", capabilities: ["browser"] });
    const id = (created.body.computer as { id: string }).id;
    const done = await f.api(`/api/v1/computers/${id}/forget-logins`, {});
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.deepEqual(done.body, { ok: true });
    assert.deepEqual(f.forgotten, [id]);
    assert.equal(f.daemon.store.getComputer(id)?.id, id);
  } finally {
    await f.close();
  }
});

test("POST forget-logins 409s a concurrent task start and restores after failure", async () => {
  let proceed!: () => void;
  const gate = new Promise<void>((resolve) => {
    proceed = resolve;
  });
  let inForget = false;
  const f = await daemonFixture({
    forgetLogins: async () => {
      inForget = true;
      await gate;
      throw new Error("recreate failed");
    },
  });
  try {
    const created = await f.api("/api/v1/computers", { name: "Race", capabilities: ["browser"] });
    const id = (created.body.computer as { id: string }).id;
    const forgetP = f.api(`/api/v1/computers/${id}/forget-logins`, {});
    while (!inForget) await delay(5);
    const raced = await f.api("/api/v1/tasks", { computer_id: id, goal: "Read mail" });
    assert.equal(raced.status, 409, JSON.stringify(raced.body));
    proceed();
    const failed = await forgetP;
    assert.equal(failed.status, 503);
    assert.equal(failed.body.error, "E_SANDBOX");
    assert.equal(f.daemon.store.getComputer(id)?.status, "stopped");
    const after = await f.api("/api/v1/tasks", { computer_id: id, goal: "Read mail" });
    assert.equal(after.status, 201, JSON.stringify(after.body));
  } finally {
    await f.close();
  }
});
