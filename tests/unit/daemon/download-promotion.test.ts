import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { CSRF_HEADER, SESSION_COOKIE } from "../../../src/daemon/auth.ts";
import { startDaemon, type DaemonHandle } from "../../../src/daemon/server.ts";

process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";

const MCP = "promotion-mcp-token-aaaaaaaa";
const BOOT = "promotion-bootstrap-token-bbbbbbbb";

describe("download promotion UI routes", () => {
  let daemon: DaemonHandle;
  let origin: string;
  let cookie: string;
  let csrf: string;
  let computerId: string;
  let itemId: string;

  before(async () => {
    daemon = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      listen: false,
      mcpToken: MCP,
      bootstrapToken: BOOT,
      workspaceRoot: mkdtempSync(join(tmpdir(), "mb-promotion-daemon-")),
    });
    origin = "http://127.0.0.1:0";
    const boot = await request("/api/v1/session/bootstrap", {
      method: "POST",
      body: { token: BOOT },
    });
    csrf = boot.json.csrf;
    cookie = String(boot.headers["set-cookie"]).split(";")[0]!;
    assert.match(cookie, new RegExp(SESSION_COOKIE));
    const created = await ui("/api/v1/computers", {
      method: "POST",
      csrf: true,
      body: { name: "promotion", capabilities: ["browser", "shell"] },
    });
    computerId = created.json.computer.id;
    const listed = await ui(`/api/v1/computers/${computerId}/quarantine`);
    itemId = listed.json.items[0].id;
  });

  after(async () => {
    await daemon.close();
  });

  async function request(
    path: string,
    opts: { method?: string; csrf?: boolean; body?: unknown; bearer?: boolean } = {},
  ): Promise<{ status: number; json: any; headers: Record<string, unknown> }> {
    const headers: Record<string, string> = { origin, host: "127.0.0.1:0" };
    if (opts.bearer) headers.authorization = `Bearer ${MCP}`;
    else if (cookie) headers.cookie = cookie;
    if (opts.csrf) headers[CSRF_HEADER] = csrf;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const req = Readable.from(
      opts.body === undefined ? [] : [JSON.stringify(opts.body)],
    ) as IncomingMessage;
    req.method = opts.method ?? "GET";
    req.url = path;
    req.headers = headers;
    return await new Promise((resolve) => {
      const responseHeaders: Record<string, unknown> = {};
      const res = {
        headersSent: false,
        writeHead(status: number, values: Record<string, unknown>) {
          this.headersSent = true;
          Object.assign(responseHeaders, values);
          this.statusCode = status;
        },
        end(payload: string) {
          resolve({
            status: this.statusCode,
            json: JSON.parse(payload),
            headers: responseHeaders,
          });
        },
      } as unknown as ServerResponse;
      daemon.server.emit("request", req, res);
    });
  }

  const ui = request;

  it("rejects mcp_token on promotion with the UI-route 403", async () => {
    const result = await ui(
      `/api/v1/computers/${computerId}/quarantine/${itemId}/promote`,
      { method: "POST", bearer: true },
    );
    assert.equal(result.status, 403);
    assert.equal(result.json.message, "mcp_token not valid on UI routes");
  });

  it("rejects promotion without CSRF", async () => {
    const result = await ui(
      `/api/v1/computers/${computerId}/quarantine/${itemId}/promote`,
      { method: "POST" },
    );
    assert.equal(result.status, 403);
    assert.equal(result.json.message, "missing or invalid CSRF");
  });

  it("promotes through a UI session and audits actor, item, computer, and path", async () => {
    const result = await ui(
      `/api/v1/computers/${computerId}/quarantine/${itemId}/promote`,
      { method: "POST", csrf: true },
    );
    assert.equal(result.status, 200);
    assert.match(result.json.download.workspace_path, /^\/workspace\/download_[a-f0-9]{24}-sample\.txt$/);

    const audit = await ui("/api/v1/audit?limit=20");
    const record = audit.json.records.find((row: { type: string }) => row.type === "download.promoted");
    const body = JSON.parse(record.body_json);
    assert.equal(record.computer_id, computerId);
    assert.equal(body.approved_by, "human");
    assert.match(body.ui_session_hash, /^[a-f0-9]{64}$/);
    assert.equal(body.item_id, itemId);
    assert.equal(body.computer_id, computerId);
    assert.equal(body.workspace_path, result.json.download.workspace_path);
  });
});
