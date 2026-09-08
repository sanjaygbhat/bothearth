#!/usr/bin/env node
/**
 * WP12 — W2 exit gate: deterministic MCP smoke against real daemon + images.
 *
 * Fixture reachability (RFC1918 / localhost blocked by egress proxy):
 *   A dedicated container joins the computer's *internal* Docker network with
 *   `--network-alias fixtures` and serves `tests/fixtures/site` via
 *   `python -m http.server`. Browser `NO_PROXY` includes `fixtures`, so
 *   `http://fixtures/` is fetched directly on the internal net and never
 *   hairpins through the proxy (which would deny the resolved RFC1918 address).
 *
 * Usage: `node --experimental-strip-types scripts/mcp-smoke.ts`
 * Exit 0 only when every row PASSes.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startDaemon } from "../src/daemon/server.ts";
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  mintToken,
} from "../src/daemon/auth.ts";
import { resourceNames } from "../src/sandbox/names.ts";
import { workspaceHostPath } from "../src/sandbox/lifecycle.ts";
import { withDockerLock } from "../tests/docker-int/lock.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "tests", "fixtures", "site");
const COMPUTER = `mcpsmoke${process.pid}`
  .replace(/[^a-z0-9]/gi, "")
  .toLowerCase()
  .slice(0, 20);
const FIXTURES = `modelbot-${COMPUTER}-fixtures`;
const ARTIFACT_MARK = "modelbot-mcp-smoke-artifact";

type Row = { step: string; ok: boolean; detail?: string; ms: number };

function docker(args: string[], opts?: { allowFail?: boolean }): string {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if ((r.status ?? 1) !== 0 && !opts?.allowFail) {
    throw new Error(`docker ${args.join(" ")} → ${r.stderr || r.stdout}`);
  }
  return r.stdout ?? "";
}

function parseTool(result: CallToolResult): {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
} {
  const text = result.content.find((c) => c.type === "text");
  if (!text || text.type !== "text") {
    return { ok: false, error: { code: "E_IO", message: "no text content" } };
  }
  return JSON.parse(text.text) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
}

function findWorkspaceArtifacts(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findWorkspaceArtifacts(path));
    else if (
      entry.isFile() &&
      readFileSync(path, "utf8").includes(ARTIFACT_MARK)
    ) {
      found.push(path);
    }
  }
  return found;
}

async function step(
  rows: Row[],
  name: string,
  fn: () => Promise<string | void>,
): Promise<boolean> {
  const t0 = Date.now();
  try {
    const detail = (await fn()) ?? "ok";
    rows.push({ step: name, ok: true, detail: String(detail), ms: Date.now() - t0 });
    return true;
  } catch (e) {
    rows.push({
      step: name,
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      ms: Date.now() - t0,
    });
    return false;
  }
}

function printTable(rows: Row[], totalMs: number): void {
  const w = Math.max(4, ...rows.map((r) => r.step.length));
  console.log("\nMCP-SMOKE RESULTS");
  console.log(`${"STEP".padEnd(w)}  RESULT  MS     DETAIL`);
  for (const r of rows) {
    console.log(
      `${r.step.padEnd(w)}  ${r.ok ? "PASS" : "FAIL"}    ${String(r.ms).padStart(5)}  ${r.detail ?? ""}`,
    );
  }
  const pass = rows.every((r) => r.ok);
  console.log(
    `\nTOTAL ${totalMs}ms  ${pass ? "PASS" : "FAIL"} (${rows.filter((r) => r.ok).length}/${rows.length})`,
  );
}

async function startFixtures(computerName: string): Promise<void> {
  const nets = resourceNames(computerName);
  docker(["rm", "-f", FIXTURES], { allowFail: true });
  // serve.py forces Content-Disposition on artifact.txt so Chromium downloads
  // (plain http.server may navigate inline and never fire Playwright download).
  docker([
    "run",
    "-d",
    "--name",
    FIXTURES,
    "--network",
    nets.networkInternal,
    "--network-alias",
    "fixtures",
    "-v",
    `${SITE}:/site:ro`,
    "python:3.11-slim",
    "python",
    "/site/serve.py",
  ]);
  for (let i = 0; i < 40; i++) {
    const probe = spawnSync(
      "docker",
      [
        "exec",
        FIXTURES,
        "python",
        "-c",
        "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1/').read()[:120].decode())",
      ],
      { encoding: "utf8" },
    );
    if (probe.status === 0 && (probe.stdout ?? "").includes("MCP Smoke")) return;
    await sleep(250);
  }
  throw new Error("fixtures http.server not ready");
}

async function runSmoke(): Promise<number> {
  const t0 = Date.now();
  const rows: Row[] = [];
  const workspaceRoot = mkdtempSync(join(tmpdir(), "modelbot-mcp-smoke-"));
  const mcpToken = mintToken(24);
  const bootstrapToken = mintToken(24);

  delete process.env.MODELBOT_TEST_FAKE_COMPUTER;
  // Always the shipped Chromium seccomp profile — never unconfined (WP25 / C-B5).
  process.env.MODELBOT_SECCOMP = join(ROOT, "sandbox", "seccomp-chromium.json");
  // Test-only: fixtures alias lives on the internal net and must bypass the egress proxy.
  process.env.MODELBOT_PROXY_BYPASS ??= "localhost,127.0.0.1,fixtures";
  // Mount host computer-server so proxy-bypass-list fix is picked up without image rebuild.
  process.env.MODELBOT_TEST_DEV_ROOT ??= ROOT;

  const daemon = await startDaemon({
    host: "127.0.0.1",
    port: 0,
    mcpToken,
    bootstrapToken,
    workspaceRoot,
    sqlitePath: join(workspaceRoot, "daemon.sqlite"),
    // Smoke fixtures live on the internal Docker alias; declare them so
    // navigate/click aren't stuck in E_POLICY_PENDING (production gate).
    declaredOrigins: {
      readable: ["http://fixtures"],
      writable: ["http://fixtures"],
    },
  });

  let client: Client | null = null;
  let computerId = "";

  try {
    await step(rows, "auth: /mcp without bearer → 401", async () => {
      const res = await fetch(`${daemon.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Host: `127.0.0.1:${daemon.port}`,
        },
        body: "{}",
      });
      if (res.status !== 401) throw new Error(`status ${res.status}`);
      return `status=${res.status}`;
    });

    await step(rows, "auth: /mcp with browser Origin → 403", async () => {
      const res = await fetch(`${daemon.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${mcpToken}`,
          Origin: `http://127.0.0.1:${daemon.port}`,
          Host: `127.0.0.1:${daemon.port}`,
        },
        body: "{}",
      });
      if (res.status !== 403) throw new Error(`status ${res.status}`);
      return `status=${res.status}`;
    });

    let cookie = "";
    let csrf = "";
    await step(rows, "ui session bootstrap", async () => {
      const res = await fetch(`${daemon.baseUrl}/api/v1/session/bootstrap`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Origin: `http://127.0.0.1:${daemon.port}`,
          Host: `127.0.0.1:${daemon.port}`,
        },
        body: JSON.stringify({ token: bootstrapToken }),
      });
      if (res.status !== 200) throw new Error(`status ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { csrf: string };
      csrf = body.csrf;
      const set = res.headers.getSetCookie?.() ?? [];
      cookie = set.map((c) => c.split(";")[0]!).join("; ");
      if (!cookie.includes(SESSION_COOKIE)) throw new Error("missing session cookie");
      return "csrf ok";
    });

    const ui = async (
      path: string,
      init: { method?: string; body?: unknown } = {},
    ) => {
      const res = await fetch(`${daemon.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: {
          "content-type": "application/json",
          Origin: `http://127.0.0.1:${daemon.port}`,
          Host: `127.0.0.1:${daemon.port}`,
          cookie,
          [CSRF_HEADER]: csrf,
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      const text = await res.text();
      let json: unknown = text;
      try {
        json = JSON.parse(text);
      } catch {
        /* keep */
      }
      return { status: res.status, json };
    };

    await step(rows, "create computer", async () => {
      const r = await ui("/api/v1/computers", {
        method: "POST",
        body: { name: COMPUTER, capabilities: ["browser", "shell"] },
      });
      if (r.status !== 201) throw new Error(`status ${r.status} ${JSON.stringify(r.json)}`);
      computerId = String((r.json as { computer: { id: string } }).computer.id);
      return computerId;
    });

    await step(rows, "fixtures container on internal net", async () => {
      await startFixtures(computerId || COMPUTER);
      return "alias=fixtures";
    });

    const transport = new StreamableHTTPClientTransport(
      new URL(`${daemon.baseUrl}/mcp`),
      {
        requestInit: {
          headers: {
            Authorization: `Bearer ${mcpToken}`,
            Host: `127.0.0.1:${daemon.port}`,
          },
        },
      },
    );
    client = new Client({ name: "mcp-smoke", version: "0.0.1" });

    await step(rows, "mcp initialize + tools/list", async () => {
      await client!.connect(transport);
      const listed = await client!.listTools();
      if (listed.tools.length < 10) throw new Error(`only ${listed.tools.length} tools`);
      return `${listed.tools.length} tools`;
    });

    const call = async (
      name: string,
      args: Record<string, unknown>,
      timeoutMs = 60_000,
    ) => {
      const raw = (await client!.callTool(
        { name, arguments: args },
        undefined,
        { timeout: timeoutMs },
      )) as CallToolResult;
      return parseTool(raw);
    };

    let snapshotId = "";
    let linkRef = "";
    let inputRef = "";
    let takeoverId = "";
    let quarantineItemId = "";
    let promotedHostPath = "";

    await step(rows, "navigate fixture", async () => {
      const r = await call("browser_navigate", {
        url: "http://fixtures/",
        wait_until: "load",
      });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return String(r.data?.url ?? "ok");
    });

    await step(rows, "snapshot (home)", async () => {
      const r = await call("browser_snapshot", {
        scope: null,
        interactive_only: true,
        depth: null,
        max_chars: 8000,
      });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      snapshotId = String(r.data?.snapshot_id ?? "");
      const yaml = String(r.data?.yaml ?? "");
      const m =
        yaml.match(/Continue to form[^\n]*\[ref=([^\]]+)\]/) ??
        yaml.match(/link[^\n]*\[ref=([^\]]+)\]/);
      linkRef = m?.[1] ?? "";
      if (!snapshotId || !linkRef) {
        throw new Error(`snap=${snapshotId} ref=${linkRef} yaml=${yaml.slice(0, 240)}`);
      }
      return `snapshot_id=${snapshotId} ref=${linkRef}`;
    });

    await step(rows, "click link by ref", async () => {
      const r = await call("browser_click", {
        snapshot_id: snapshotId,
        ref: linkRef,
        button: "left",
        double_click: false,
      });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return "clicked";
    });

    await step(rows, "snapshot (form) + type", async () => {
      const snap = await call("browser_snapshot", {
        scope: null,
        interactive_only: true,
        depth: null,
        max_chars: 8000,
      });
      if (!snap.ok) throw new Error(JSON.stringify(snap.error));
      snapshotId = String(snap.data?.snapshot_id ?? "");
      const yaml = String(snap.data?.yaml ?? "");
      const m =
        yaml.match(/textbox[^\n]*\[ref=([^\]]+)\]/) ??
        yaml.match(/\[ref=([^\]]+)\]/);
      inputRef = m?.[1] ?? "";
      if (!inputRef) throw new Error(`no input ref in ${yaml.slice(0, 300)}`);
      const typed = await call("browser_type", {
        snapshot_id: snapshotId,
        ref: inputRef,
        text: "mcp-smoke",
        submit: false,
        slowly: false,
      });
      if (!typed.ok) throw new Error(JSON.stringify(typed.error));
      return `typed into ${inputRef}`;
    });

    await step(rows, "request_takeover + grant", async () => {
      const r = await call("request_takeover", {
        reason: "mcp-smoke",
        category: null,
      }, 45_000);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      takeoverId = String(r.data?.takeover_id ?? "");
      if (!takeoverId) throw new Error("missing takeover_id");
      const grant = await ui(
        `/api/v1/takeover/${encodeURIComponent(takeoverId)}/grant`,
        { method: "POST", body: {} },
      );
      if (grant.status !== 200) {
        throw new Error(`grant ${grant.status} ${JSON.stringify(grant.json)}`);
      }
      return takeoverId;
    });

    await step(rows, "browser_click → E_TAKEOVER_BUSY", async () => {
      const r = await call("browser_click", {
        snapshot_id: snapshotId,
        ref: inputRef || linkRef,
        button: "left",
        double_click: false,
      });
      if (r.ok) throw new Error("expected failure during HUMAN");
      if (r.error?.code !== "E_TAKEOVER_BUSY") {
        throw new Error(`code=${r.error?.code} ${r.error?.message}`);
      }
      return r.error.code;
    });

    await step(rows, "UI release takeover", async () => {
      const r = await ui(
        `/api/v1/takeover/${encodeURIComponent(takeoverId)}/release`,
        { method: "POST", body: {} },
      );
      if (r.status !== 200) throw new Error(`status ${r.status} ${JSON.stringify(r.json)}`);
      return "released";
    });

    await step(rows, "snapshot again (post-release)", async () => {
      const r = await call("browser_snapshot", {
        scope: null,
        interactive_only: true,
        depth: null,
        max_chars: 8000,
      });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      snapshotId = String(r.data?.snapshot_id ?? "");
      return snapshotId;
    });

    await step(rows, "download: navigate home", async () => {
      const nav = await call(
        "browser_navigate",
        { url: "http://fixtures/", wait_until: "load" },
        30_000,
      );
      if (!nav.ok) throw new Error(JSON.stringify(nav.error));
      return String(nav.data?.url ?? "ok");
    });

    await step(rows, "download: snapshot + click", async () => {
      const snap = await call(
        "browser_snapshot",
        {
          scope: null,
          interactive_only: true,
          depth: null,
          max_chars: 8000,
        },
        30_000,
      );
      if (!snap.ok) throw new Error(JSON.stringify(snap.error));
      const yaml = String(snap.data?.yaml ?? "");
      const m = yaml.match(/Download artifact[^\n]*\[ref=([^\]]+)\]/);
      const ref = m?.[1];
      if (!ref) throw new Error(`download link missing: ${yaml.slice(0, 300)}`);
      const click = await call(
        "browser_click",
        {
          snapshot_id: String(snap.data?.snapshot_id),
          ref,
          button: "left",
          double_click: false,
        },
        20_000,
      );
      if (!click.ok) throw new Error(JSON.stringify(click.error));
      await sleep(800);
      const downloaded = click.data?.downloaded;
      return `clicked ${ref}${downloaded ? ` downloaded=${downloaded}` : ""}`;
    });

    await step(rows, "download: absent from workspace", async () => {
      const hostWs = workspaceHostPath(computerId || COMPUTER, workspaceRoot);
      if (existsSync(join(hostWs, ".quarantine"))) {
        throw new Error("legacy workspace/.quarantine exists");
      }
      for (let i = 0; i < 40; i++) {
        const found = findWorkspaceArtifacts(hostWs);
        if (found.length) {
          throw new Error(`unapproved artifact in workspace: ${found.join(",")}`);
        }
        const r = await ui(
          `/api/v1/computers/${encodeURIComponent(computerId)}/quarantine`,
        );
        if (r.status !== 200) {
          throw new Error(`status ${r.status} ${JSON.stringify(r.json)}`);
        }
        const items = (r.json as { items?: Array<{ name: string }> }).items ?? [];
        if (items.some((item) => item.name === "artifact.txt")) {
          if (findWorkspaceArtifacts(hostWs).length) {
            throw new Error("unapproved artifact appeared in workspace");
          }
          return "artifact absent after quarantine completed; no workspace/.quarantine";
        }
        await sleep(250);
      }
      throw new Error("download did not reach quarantine");
    });

    await step(rows, "download: listed in quarantine", async () => {
      const expectedSize = readFileSync(join(SITE, "artifact.txt")).byteLength;
      for (let i = 0; i < 40; i++) {
        const r = await ui(
          `/api/v1/computers/${encodeURIComponent(computerId)}/quarantine`,
        );
        if (r.status !== 200) {
          throw new Error(`status ${r.status} ${JSON.stringify(r.json)}`);
        }
        const items = (
          r.json as {
            items?: Array<{ id: string; name: string; size: number }>;
          }
        ).items ?? [];
        const item = items.find((candidate) => candidate.name === "artifact.txt");
        if (item) {
          if (item.size !== expectedSize) {
            throw new Error(`artifact.txt size=${item.size}, expected=${expectedSize}`);
          }
          quarantineItemId = item.id;
          return `${item.name} size=${item.size} id=${item.id}`;
        }
        await sleep(250);
      }
      throw new Error("artifact.txt not listed in quarantine");
    });

    await step(rows, "download: mcp promote rejected", async () => {
      const path = `/api/v1/computers/${encodeURIComponent(computerId)}/quarantine/${encodeURIComponent(quarantineItemId)}/promote`;
      const res = await fetch(`${daemon.baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${mcpToken}`,
          Origin: `http://127.0.0.1:${daemon.port}`,
          Host: `127.0.0.1:${daemon.port}`,
        },
      });
      if (res.status !== 403) {
        throw new Error(`status ${res.status} ${await res.text()}`);
      }
      return "status=403";
    });

    await step(rows, "download: UI promotes with CSRF", async () => {
      const r = await ui(
        `/api/v1/computers/${encodeURIComponent(computerId)}/quarantine/${encodeURIComponent(quarantineItemId)}/promote`,
        { method: "POST", body: {} },
      );
      if (r.status !== 200) {
        throw new Error(`status ${r.status} ${JSON.stringify(r.json)}`);
      }
      const workspacePath = String(
        (r.json as { download?: { workspace_path?: string } }).download
          ?.workspace_path ?? "",
      );
      if (!/^\/workspace\/download_[a-f0-9]{24}-artifact\.txt$/.test(workspacePath)) {
        throw new Error(`unexpected workspace_path=${workspacePath}`);
      }
      promotedHostPath = join(
        workspaceHostPath(computerId || COMPUTER, workspaceRoot),
        workspacePath.slice("/workspace/".length),
      );
      return workspacePath;
    });

    await step(rows, "download: promoted host workspace file", async () => {
      const hostWs = workspaceHostPath(computerId || COMPUTER, workspaceRoot);
      const found = findWorkspaceArtifacts(hostWs);
      if (found.length !== 1 || found[0] !== promotedHostPath) {
        throw new Error(
          `workspace artifacts=${found.join(",")} expected=${promotedHostPath}`,
        );
      }
      const body = readFileSync(promotedHostPath);
      if (!body.length || !body.toString("utf8").includes(ARTIFACT_MARK)) {
        throw new Error(`empty or invalid artifact: ${promotedHostPath}`);
      }
      return `${promotedHostPath} size=${body.length}`;
    });

    await step(rows, "destroy computer", async () => {
      // Fixtures hold an endpoint on the internal network — remove first.
      docker(["rm", "-f", FIXTURES], { allowFail: true });
      const r = await ui(`/api/v1/computers/${encodeURIComponent(computerId)}`, {
        method: "DELETE",
      });
      if (r.status !== 200) throw new Error(`status ${r.status} ${JSON.stringify(r.json)}`);
      return "destroyed";
    });
  } finally {
    try {
      await client?.close();
    } catch {
      /* ignore */
    }
    docker(["rm", "-f", FIXTURES], { allowFail: true });
    try {
      await daemon.close();
    } catch {
      /* ignore */
    }
    try {
      rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const total = Date.now() - t0;
  printTable(rows, total);

  const receipt = join(ROOT, "docs", "internal", "build", "mcp-smoke-last.json");
  mkdirSync(dirname(receipt), { recursive: true });
  writeFileSync(
    receipt,
    JSON.stringify({ ok: rows.every((r) => r.ok), total_ms: total, rows }, null, 2),
  );

  return rows.every((r) => r.ok) ? 0 : 1;
}

const code = await withDockerLock(() => runSmoke());
process.exit(code);
