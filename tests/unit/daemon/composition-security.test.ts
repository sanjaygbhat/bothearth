/**
 * Production-composition security tests.
 * Real daemon wiring (shared dispatcher + fake computer), not injectable hooks.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startDaemon, type DaemonHandle } from "../../../src/daemon/server.ts";
import { OPTIONAL_POLICY_GATES } from "../../../src/types/contracts.ts";
import { CSRF_HEADER, SESSION_COOKIE } from "../../../src/daemon/auth.ts";
import { verifyAuditFile } from "../../../src/audit/verify.ts";
import { AuditLog } from "../../../src/audit/log.ts";
import { staticAuditKey } from "../../../src/audit/key.ts";

process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";

const MCP = `composition-mcp-${randomBytes(8).toString("hex")}`;
const BOOT = `composition-boot-${randomBytes(8).toString("hex")}`;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const CLI = join(ROOT, "src/cli/index.ts");

describe("production composition security", () => {
  let daemon: DaemonHandle;
  let base: string;
  let origin: string;
  let cookie = "";
  let csrf = "";
  let auditDir: string;
  let auditPath: string;
  let auditKey: Buffer;
  let workspaceRoot: string;

  before(async () => {
    auditDir = mkdtempSync(join(tmpdir(), "composition-audit-"));
    auditPath = join(auditDir, "audit.jsonl");
    auditKey = randomBytes(32);
    workspaceRoot = mkdtempSync(join(tmpdir(), "composition-ws-"));
    const auditLog = new AuditLog({
      path: auditPath,
      keyProvider: staticAuditKey(auditKey),
    });
    daemon = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      mcpToken: MCP,
      bootstrapToken: BOOT,
      auditLog,
      workspaceRoot,
      enabledGates: [...OPTIONAL_POLICY_GATES],
    });
    base = daemon.baseUrl;
    origin = `http://127.0.0.1:${daemon.port}`;
  });

  after(async () => {
    await daemon.close();
    rmSync(auditDir, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  async function api(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      omitOrigin?: boolean;
    } = {},
  ): Promise<{ status: number; json: any; setCookie: string[] }> {
    const headers: Record<string, string> = {
      ...(init.omitOrigin ? {} : { Origin: origin }),
      Host: `127.0.0.1:${daemon.port}`,
      ...(init.headers ?? {}),
    };
    if (cookie) headers.cookie = cookie;
    if (csrf && (init.method ?? "GET") !== "GET") headers[CSRF_HEADER] = csrf;
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
      /* keep */
    }
    return {
      status: res.status,
      json,
      setCookie: res.headers.getSetCookie?.() ?? [],
    };
  }

  function reseedBootstrap(): void {
    const hash = createHash("sha256").update(BOOT).digest("hex");
    // Reset only this fixture; production registration never resurrects a used token.
    daemon.store.db.prepare("DELETE FROM bootstrap_tokens WHERE token_hash = ?").run(hash);
    daemon.store.registerBootstrapToken(
      hash,
      new Date(Date.now() + 3600_000).toISOString(),
    );
  }

  /** MCP requires exactly one running computer. */
  async function stopOtherComputers(keepId: string): Promise<void> {
    const listed = await api("/api/v1/computers");
    const computers = (listed.json.computers ?? []) as Array<{ id: string; status: string }>;
    for (const c of computers) {
      if (c.id !== keepId && c.status === "running") {
        await api(`/api/v1/computers/${c.id}/stop`, { method: "POST" });
      }
    }
  }

  function parseMcpTool(result: CallToolResult): {
    ok: boolean;
    error?: { code: string; details?: Record<string, unknown> };
  } {
    const text = result.content.find((c) => c.type === "text");
    assert.ok(text && text.type === "text", "mcp tool missing text");
    return JSON.parse(text.text) as {
      ok: boolean;
      error?: { code: string; details?: Record<string, unknown> };
    };
  }

  async function withMcp<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${MCP}`,
          Host: `127.0.0.1:${daemon.port}`,
        },
      },
    });
    const client = new Client({ name: "composition-client", version: "0.0.1" });
    await client.connect(transport);
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  it("bootstrap is single-use POST; GET rejected; UI served with CSP", async () => {
    assert.equal((await api("/api/v1/session/bootstrap", { method: "GET" })).status, 405);

    const first = await api("/api/v1/session/bootstrap", {
      method: "POST",
      body: { token: BOOT },
    });
    assert.equal(first.status, 200);
    cookie = first.setCookie.map((c) => c.split(";")[0]!).join("; ");
    csrf = first.json.csrf;
    assert.match(cookie, new RegExp(SESSION_COOKIE));

    const replay = await api("/api/v1/session/bootstrap", {
      method: "POST",
      body: { token: BOOT },
    });
    assert.equal(replay.status, 401);

    reseedBootstrap();
    const again = await api("/api/v1/session/bootstrap", {
      method: "POST",
      body: { token: BOOT },
    });
    assert.equal(again.status, 200);
    cookie = again.setCookie.map((c) => c.split(";")[0]!).join("; ");
    csrf = again.json.csrf;

    const ui = await api("/");
    assert.equal(ui.status, 200);
  });

  it("gated catalogue tool via /mcp → E_POLICY_PENDING", async () => {
    const created = await api("/api/v1/computers", {
      method: "POST",
      body: { name: "mcp-gate", capabilities: ["browser", "shell"] },
    });
    assert.ok(created.status === 201 || created.status === 200);
    const computerId = created.json.computer.id as string;
    await stopOtherComputers(computerId);

    const result = await withMcp(async (client) =>
      parseMcpTool(
        (await client.callTool({
          name: "browser_upload",
          arguments: {
            snapshot_id: "snap",
            ref: "e1",
            paths: ["/workspace/a.txt"],
          },
        })) as CallToolResult,
      ),
    );
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "E_POLICY_PENDING");
    assert.equal(typeof result.error?.details?.approval_id, "string");
  });

  it("path traversal + symlink escape on computer files route → 403", async () => {
    const created = await api("/api/v1/computers", {
      method: "POST",
      body: { name: "files", capabilities: ["browser"] },
    });
    const id = created.json.computer.id as string;
    const escaped = await api(
      `/api/v1/computers/${encodeURIComponent("..")}%2F..%2Fetc/files?path=passwd`,
    );
    assert.ok(escaped.status === 403 || escaped.status === 404);
    const rel = await api(`/api/v1/computers/${id}/files?path=../../../etc/passwd`);
    assert.ok(rel.status === 403 || rel.status === 404);
    assert.notEqual(rel.status, 200);
    const body = typeof rel.json === "string" ? rel.json : JSON.stringify(rel.json);
    assert.equal(body.includes("root:"), false);

    const ws = join(workspaceRoot, id);
    mkdirSync(ws, { recursive: true });
    symlinkSync("/etc/passwd", join(ws, "escape"));
    const sym = await api(`/api/v1/computers/${id}/files?path=escape`);
    assert.ok(sym.status === 403 || sym.status === 404, `symlink status=${sym.status}`);
    assert.notEqual(sym.status, 200);
    const symBody = typeof sym.json === "string" ? sym.json : JSON.stringify(sym.json);
    assert.equal(symBody.includes("root:"), false);
  });

  it("debug tool route is absent", async () => {
    const r = await api("/api/v1/debug/tool", {
      method: "POST",
      body: { computer_id: "x", method: "browser_navigate", params: {} },
    });
    assert.equal(r.status, 404);
  });

  it("approval decide rejects bind mismatch / expired / re-decide", async () => {
    const created = await api("/api/v1/computers", {
      method: "POST",
      body: { name: "approvals", capabilities: ["browser", "shell"] },
    });
    const computerId = created.json.computer.id as string;
    const pending = (await daemon.callTool(computerId, "files_delete", {
      path: "/workspace/x",
    })) as {
      error?: {
        details?: { approval_id?: string; bind?: Record<string, unknown> };
      };
    };
    const approvalId = pending.error?.details?.approval_id;
    const bind = pending.error?.details?.bind;
    assert.ok(approvalId && bind);

    const mismatch = await api(`/api/v1/approvals/${approvalId}`, {
      method: "POST",
      body: {
        decision: "allow_once",
        bind: { ...bind, origin: "https://attacker.example" },
      },
    });
    assert.equal(mismatch.status, 409);

    const deny = await api(`/api/v1/approvals/${approvalId}`, {
      method: "POST",
      body: { decision: "deny", bind },
    });
    assert.equal(deny.status, 200);

    const again = await api(`/api/v1/approvals/${approvalId}`, {
      method: "POST",
      body: { decision: "allow_once", bind },
    });
    assert.equal(again.status, 409);

    const expiredBind = {
      task_id: "t_expired",
      control_epoch: 1,
      origin: "https://example.com",
      action_hash: "a".repeat(64),
      expires: new Date(Date.now() - 60_000).toISOString(),
    };
    const expired = daemon.store.insertApproval({
      task_id: "t_expired",
      tool: "files_delete",
      args: { path: "/workspace/y" },
      gate: "delete",
      bind: expiredBind,
    });
    const expiredDecide = await api(`/api/v1/approvals/${expired.id}`, {
      method: "POST",
      body: { decision: "allow_once", bind: expiredBind },
    });
    assert.equal(expiredDecide.status, 409);
  });

  it("takeover HUMAN blocks browser + shell via /mcp", async () => {
    const created = await api("/api/v1/computers", {
      method: "POST",
      body: { name: "takeover", capabilities: ["browser", "shell"] },
    });
    const computerId = created.json.computer.id as string;
    await stopOtherComputers(computerId);

    const req = await api("/api/v1/takeover/request", {
      method: "POST",
      body: { computer_id: computerId, reason: "composition check" },
    });
    assert.equal(req.status, 200);
    const tk = req.json.takeover.takeover_id as string;
    assert.equal((await api(`/api/v1/takeover/${tk}/grant`, { method: "POST" })).status, 200);

    await withMcp(async (client) => {
      const browser = parseMcpTool(
        (await client.callTool({
          name: "browser_click",
          arguments: {
            snapshot_id: "snap_x",
            ref: "e1",
            button: "left",
            double_click: false,
          },
        })) as CallToolResult,
      );
      assert.equal(browser.ok, false);
      assert.equal(browser.error?.code, "E_TAKEOVER_BUSY");

      const shell = parseMcpTool(
        (await client.callTool({
          name: "shell_exec",
          arguments: { command: "echo should-not-run" },
        })) as CallToolResult,
      );
      assert.equal(shell.ok, false);
      assert.equal(shell.error?.code, "E_TAKEOVER_BUSY");
    });

    assert.equal((await api(`/api/v1/takeover/${tk}/release`, { method: "POST" })).status, 200);
  });

  it("scheme-invalid navigation refused", async () => {
    const created = await api("/api/v1/computers", {
      method: "POST",
      body: { name: "scheme", capabilities: ["browser"] },
    });
    const computerId = created.json.computer.id as string;
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi"]) {
      const res = (await daemon.callTool(computerId, "browser_navigate", { url })) as {
        ok: boolean;
        error?: { code: string };
      };
      assert.equal(res.ok, false, url);
      assert.ok(
        res.error?.code === "E_POLICY" || res.error?.code === "E_POLICY_PENDING",
        `${url} → ${res.error?.code}`,
      );
    }
  });

  it("HMAC audit log verifies; CLI passes; tamper fails", async () => {
    await api("/api/v1/computers", {
      method: "POST",
      body: { name: "audit", capabilities: ["browser"] },
    });
    const verified = verifyAuditFile(auditKey, auditPath);
    assert.equal(verified.ok, true, JSON.stringify(verified));

    const keyPath = join(auditDir, "audit.key");
    writeFileSync(keyPath, auditKey, { mode: 0o600 });
    const ok = spawnSync(
      process.execPath,
      ["--experimental-strip-types", CLI, "audit", "verify", "--path", auditPath, "--key-file", keyPath],
      { encoding: "utf8" },
    );
    assert.equal(ok.status, 0, ok.stderr || ok.stdout);

    const tamperedPath = join(auditDir, "audit.tampered.jsonl");
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    assert.ok(lines.length >= 1);
    const mid = JSON.parse(lines[Math.min(1, lines.length - 1)]!);
    mid.body = { ...(mid.body ?? {}), evil: true };
    lines[Math.min(1, lines.length - 1)] = JSON.stringify(mid);
    writeFileSync(tamperedPath, lines.join("\n") + "\n");

    const bad = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        CLI,
        "audit",
        "verify",
        "--path",
        tamperedPath,
        "--key-file",
        keyPath,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(bad.status, 0);
    assert.match(`${bad.stderr}\n${bad.stdout}`, /FAIL/i);
  });

  it("MCP bearer cannot call UI approval routes", async () => {
    const r = await api("/api/v1/approvals", {
      headers: { authorization: `Bearer ${MCP}` },
    });
    assert.ok(r.status === 401 || r.status === 403);
  });
});
