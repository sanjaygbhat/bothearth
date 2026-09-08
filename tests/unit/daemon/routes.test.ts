import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { startDaemon, type DaemonHandle } from "../../../src/daemon/server.ts";
import { CSRF_HEADER, SESSION_COOKIE } from "../../../src/daemon/auth.ts";

process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";

const MCP = "test-mcp-token-aaaaaaaa";
const BOOT = "test-boot-token-bbbbbbbb";

describe("daemon HTTP/WS", () => {
  let daemon: DaemonHandle;
  let base: string;
  let origin: string;
  let cookie = "";
  let csrf = "";

  before(async () => {
    daemon = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      mcpToken: MCP,
      bootstrapToken: BOOT,
      workspaceRoot: mkdtempSync(join(tmpdir(), "mb-routes-")),
      agentLoop: { model: "route-test", adapter: { kind: "openai_compat", complete: async (request) =>
        new Promise((_, reject) => {
          if (request.signal?.aborted) reject(new Error("cancelled"));
          else request.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
      } },
    });
    base = daemon.baseUrl;
    origin = `http://127.0.0.1:${daemon.port}`;
  });

  after(async () => {
    await daemon.close();
  });

  async function api(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      cookie?: string;
      csrf?: string;
      omitOrigin?: boolean;
    } = {},
  ): Promise<{ status: number; json: any; headers: Headers }> {
    const headers: Record<string, string> = {
      ...(init.omitOrigin ? {} : { Origin: origin }),
      Host: `127.0.0.1:${daemon.port}`,
      ...(init.headers ?? {}),
    };
    const c = init.cookie ?? cookie;
    if (c) headers.cookie = c;
    if (init.csrf ?? csrf) headers[CSRF_HEADER] = init.csrf ?? csrf;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { status: res.status, json, headers: res.headers };
  }

  it("healthz unauthenticated", async () => {
    const r = await api("/healthz", { omitOrigin: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
  });

  it("auth matrix: no cookie → 401; mcp on UI → 403; csrf missing → 403", async () => {
    assert.equal((await api("/api/v1/computers")).status, 401);
    assert.equal(
      (
        await api("/api/v1/computers", {
          headers: { authorization: `Bearer ${MCP}` },
        })
      ).status,
      403,
    );

    const boot = await api("/api/v1/session/bootstrap", {
      method: "POST",
      body: { token: BOOT },
    });
    assert.equal(boot.status, 200);
    csrf = boot.json.csrf;
    const set = boot.headers.getSetCookie?.() ?? [];
    cookie = set.map((c) => c.split(";")[0]!).join("; ");
    assert.match(cookie, new RegExp(SESSION_COOKIE));

    assert.equal(
      (
        await api("/api/v1/computers", {
          method: "POST",
          body: { name: "x", capabilities: ["browser"] },
          csrf: "",
          headers: { [CSRF_HEADER]: "" },
        })
      ).status,
      403,
    );
  });

  it("mcp: bearer required; browser Origin → 403", async () => {
    assert.equal((await api("/mcp", { omitOrigin: true })).status, 401);
    assert.equal(
      (
        await api("/mcp", {
          headers: { authorization: `Bearer ${MCP}` },
        })
      ).status,
      403,
    );
    // Authed GET without MCP session → method/session error (real streamable handler).
    assert.equal(
      (
        await api("/mcp", {
          omitOrigin: true,
          headers: { authorization: `Bearer ${MCP}` },
        })
      ).status,
      405,
    );
  });

  it("computers / tasks / usage event path", async () => {
    const created = await api("/api/v1/computers", {
      method: "POST",
      body: { name: "c1", capabilities: ["browser"] },
    });
    assert.equal(created.status, 201);
    const computerId = created.json.computer.id as string;

    const task = await api("/api/v1/tasks", {
      method: "POST",
      body: { computer_id: computerId, goal: "demo", max_steps: 3 },
    });
    assert.equal(task.status, 201);

    const eventsUrl = `${base.replace("http", "ws")}/api/v1/events`;
    const ws = new WebSocket(eventsUrl, {
      headers: { Origin: origin, Cookie: cookie },
    });
    const msg = await new Promise<any>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("events timeout")), 2000);
      ws.addEventListener("message", (ev) => {
        clearTimeout(t);
        resolve(JSON.parse(String(ev.data)));
      });
      ws.addEventListener("error", reject);
    });
    ws.close();
    assert.equal(msg.type, "usage");
  });

  it("takeover: request → grant → E_TAKEOVER_BUSY → release → resume", async () => {
    const created = await api("/api/v1/computers", {
      method: "POST",
      body: { name: "c2", capabilities: ["browser"] },
    });
    const computerId = created.json.computer.id as string;

    const req = await api("/api/v1/takeover/request", {
      method: "POST",
      body: { computer_id: computerId, reason: "login" },
    });
    assert.equal(req.status, 200);
    const tk = req.json.takeover.takeover_id as string;

    const grant = await api(`/api/v1/takeover/${tk}/grant`, { method: "POST" });
    assert.equal(grant.status, 200);
    assert.equal(grant.json.takeover.state, "human");

    const busy = await daemon.callTool(computerId, "browser_navigate", {
      url: "https://example.com",
    });
    assert.equal((busy as { ok: boolean }).ok, false);
    assert.equal((busy as { error: { code: string } }).error.code, "E_TAKEOVER_BUSY");

    const release = await api(`/api/v1/takeover/${tk}/release`, {
      method: "POST",
    });
    assert.equal(release.status, 200);

    // Read tool must work after release; navigate may still be policy-gated.
    const ok = await daemon.callTool(computerId, "browser_snapshot", {
      scope: null,
      interactive_only: false,
      depth: 4,
      max_chars: 2000,
    });
    assert.equal((ok as { ok: boolean }).ok, true);
  });

  it("live frames arrive; wrong Origin WS rejected", async () => {
    const created = await api("/api/v1/computers", {
      method: "POST",
      body: { name: "c3", capabilities: ["browser"] },
    });
    const computerId = created.json.computer.id as string;
    const liveUrl = `${base.replace("http", "ws")}/api/v1/live/${computerId}`;

    const ws = new WebSocket(liveUrl, {
      headers: { Origin: origin, Cookie: cookie },
    });
    const frame = await new Promise<ArrayBuffer | Blob>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("live timeout")), 2000);
      ws.addEventListener("message", (ev) => {
        clearTimeout(t);
        resolve(ev.data as ArrayBuffer | Blob);
      });
      ws.addEventListener("error", reject);
    });
    ws.close();
    assert.ok(frame);

    let rejected = false;
    try {
      const bad = new WebSocket(liveUrl, {
        headers: { Origin: "http://evil.example", Cookie: cookie },
      });
      const result = await new Promise<string>((resolve) => {
        bad.addEventListener("open", () => resolve("open"));
        bad.addEventListener("error", () => resolve("error"));
        setTimeout(() => resolve("timeout"), 400);
      });
      rejected = result !== "open";
      try {
        bad.close();
      } catch {
        /* ignore */
      }
    } catch {
      rejected = true;
    }
    assert.equal(rejected, true);
  });

  it("operator mode updates on grant and release without waiting for a new browser frame", async () => {
    const created = await api("/api/v1/computers", { method: "POST", body: { name: "live-control", capabilities: ["browser"] } });
    const computerId = created.json.computer.id as string;
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/v1/live/${computerId}`, {
      headers: { Origin: origin, Cookie: cookie },
    });
    const nextMode = (mode: string) => new Promise<{ mode: string; epoch: number }>((resolve, reject) => {
      const timeout = setTimeout(() => { ws.removeEventListener("message", listener); reject(new Error(`missing ${mode} control`)); }, 2000);
      const listener = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        const value = JSON.parse(event.data);
        if (value.t !== "mode" || value.mode !== mode) return;
        clearTimeout(timeout);
        ws.removeEventListener("message", listener);
        resolve(value);
      };
      ws.addEventListener("message", listener);
    });
    try {
      await nextMode("agent");
      const requested = await api("/api/v1/takeover/request", { method: "POST", body: { computer_id: computerId } });
      const id = requested.json.takeover.takeover_id;
      const human = nextMode("human");
      assert.equal((await api(`/api/v1/takeover/${id}/grant`, { method: "POST" })).status, 200);
      const granted = await human;
      const agent = nextMode("agent");
      assert.equal((await api(`/api/v1/takeover/${id}/release`, { method: "POST" })).status, 200);
      assert.ok((await agent).epoch >= granted.epoch);
    } finally { ws.close(); }
  });

  it("task cancel returns quickly (kill switch)", async () => {
    const created = await api("/api/v1/computers", {
      method: "POST",
      body: { name: "c4", capabilities: ["browser"] },
    });
    const computerId = created.json.computer.id as string;
    const task = await api("/api/v1/tasks", {
      method: "POST",
      body: { computer_id: computerId, goal: "long", max_steps: 99 },
    });
    const id = task.json.task.id as string;
    const t0 = Date.now();
    const cancel = await api(`/api/v1/tasks/${id}/cancel`, { method: "POST" });
    const dt = Date.now() - t0;
    assert.equal(cancel.status, 200);
    assert.ok(dt < 2000, `cancel took ${dt}ms`);
  });

  it("refuses public bind without flag", async () => {
    await assert.rejects(
      () =>
        startDaemon({
          host: "0.0.0.0",
          port: 0,
          mcpToken: MCP,
          bootstrapToken: BOOT,
        }),
      /public|loopback|allowPublicBind|refusing/i,
    );
  });
  it("an adapter name that is only an Object property is rejected", async () => {
    for (const name of ["constructor", "__proto__", "toString", "nope"]) {
      const res = await api("/api/v1/tasks", {
        method: "POST",
        body: { goal: "do a thing", adapter: name },
      });
      assert.equal(res.status, 400, `adapter "${name}" must be refused, got ${res.status}`);
      assert.match(res.json.message, /Unknown adapter/);
    }
  });
});

describe("bootstrap registration", () => {
  it("a later start with a new bootstrap token does not re-arm the previous token", async () => {
    const sqlitePath = join(mkdtempSync(join(tmpdir(), "mb-r59-boot-")), "modelbot.sqlite");
    const tokenA = "r59-boot-token-aaaa-one-time";
    const tokenB = "r59-boot-token-bbbb-fresh-mint";
    const first = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      mcpToken: MCP,
      bootstrapToken: tokenA,
      sqlitePath,
    });
    const originA = `http://127.0.0.1:${first.port}`;
    const consumeA = await fetch(`${first.baseUrl}/api/v1/session/bootstrap`, {
      method: "POST",
      headers: {
        Origin: originA,
        Host: `127.0.0.1:${first.port}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: tokenA }),
    });
    assert.equal(consumeA.status, 200);
    await first.close();

    const second = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      mcpToken: MCP,
      bootstrapToken: tokenB,
      sqlitePath,
    });
    try {
      const originB = `http://127.0.0.1:${second.port}`;
      const replayA = await fetch(`${second.baseUrl}/api/v1/session/bootstrap`, {
        method: "POST",
        headers: {
          Origin: originB,
          Host: `127.0.0.1:${second.port}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: tokenA }),
      });
      assert.equal(replayA.status, 401);
      const bootB = await fetch(`${second.baseUrl}/api/v1/session/bootstrap`, {
        method: "POST",
        headers: {
          Origin: originB,
          Host: `127.0.0.1:${second.port}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ token: tokenB }),
      });
      assert.equal(bootB.status, 200);
    } finally {
      await second.close();
    }
  });
});
