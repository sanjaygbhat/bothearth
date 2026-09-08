import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { CSRF_HEADER, SESSION_COOKIE } from "../../../src/daemon/auth.ts";
import {
  MAX_REQUEST_BODY_BYTES,
  startDaemon,
  type DaemonHandle,
} from "../../../src/daemon/server.ts";
import {
  MAX_WEBSOCKET_FRAME_BYTES,
  acceptWebSocket,
} from "../../../src/daemon/ws.ts";

process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";

const MCP = "limits-mcp-token-aaaaaaaa";
const BOOT = "limits-bootstrap-token-bbbbbbbb";

class FakeSocket extends EventEmitter {
  readonly writes: Array<string | Uint8Array> = [];
  destroyed = false;

  write(data: string | Uint8Array): boolean {
    this.writes.push(data);
    return true;
  }

  end(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }

  unshift(): void {}
}

describe("daemon security boundaries", () => {
  let daemon: DaemonHandle;
  let cookie = "";
  let csrf = "";

  async function request(
    path: string,
    opts: {
      method?: string;
      body?: unknown;
      chunks?: Buffer[];
      headers?: Record<string, string>;
      authenticated?: boolean;
    } = {},
  ): Promise<{ status: number; json: any; headers: Record<string, unknown> }> {
    const headers: Record<string, string> = {
      host: "127.0.0.1:0",
      origin: "http://127.0.0.1:0",
      ...opts.headers,
    };
    if (opts.authenticated !== false && cookie) headers.cookie = cookie;
    if (opts.authenticated !== false && csrf && opts.method === "POST") {
      headers[CSRF_HEADER] = csrf;
    }
    const chunks = opts.chunks ??
      (opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]);
    const req = Readable.from(chunks) as IncomingMessage;
    req.method = opts.method ?? "GET";
    req.url = path;
    req.headers = headers;
    return await new Promise((resolve) => {
      const responseHeaders: Record<string, unknown> = {};
      const res = {
        headersSent: false,
        statusCode: 200,
        writeHead(status: number, values: Record<string, unknown>) {
          this.headersSent = true;
          this.statusCode = status;
          Object.assign(responseHeaders, values);
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

  before(async () => {
    daemon = await startDaemon({
      host: "127.0.0.1",
      port: 0,
      listen: false,
      mcpToken: MCP,
      bootstrapToken: BOOT,
      workspaceRoot: mkdtempSync(join(tmpdir(), "modelbot-limits-")),
    });
    const boot = await request("/api/v1/session/bootstrap", {
      method: "POST",
      body: { token: BOOT },
      authenticated: false,
    });
    assert.equal(boot.status, 200);
    csrf = boot.json.csrf;
    cookie = String(boot.headers["set-cookie"]).split(";")[0]!;
    assert.match(cookie, new RegExp(SESSION_COOKIE));
  });

  after(async () => {
    await daemon.close();
  });

  it("rejects malformed request URLs and Hosts without stopping the daemon", async () => {
    for (const [path, host] of [["http://[", "127.0.0.1:0"], ["/healthz", "["]]) {
      const response = await request(path!, { headers: { host: host! }, authenticated: false });
      assert.equal(response.status, 400);
    }
    assert.equal((await request("/healthz", { authenticated: false })).status, 200);
  });

  it("serves the sealed redacted audit body, never the emitted secret", async () => {
    const secret = "sk-ur4secretabcdefghijklmnopqrstuvwxyz";
    const created = await request("/api/v1/computers", {
      method: "POST",
      body: { name: "limits", capabilities: ["browser"] },
    });
    const computerId = created.json.computer.id as string;
    const takeover = await request("/api/v1/takeover/request", {
      method: "POST",
      body: { computer_id: computerId, reason: secret },
    });
    assert.equal(takeover.status, 200);

    const audit = await request("/api/v1/audit");
    const row = audit.json.records.find(
      (record: { type: string }) => record.type === "takeover.requested",
    );
    assert.ok(row);
    assert.equal(JSON.stringify(audit.json).includes(secret), false);
    assert.equal(JSON.parse(row.body_json).reason, "[redacted]");
  });

  it("rejects oversized HTTP bodies and WebSocket frames", async () => {
    const declared = await request("/api/v1/session/bootstrap", {
      method: "POST",
      headers: { "content-length": String(MAX_REQUEST_BODY_BYTES + 1) },
      authenticated: false,
    });
    assert.equal(declared.status, 413);

    const streamed = await request("/api/v1/session/bootstrap", {
      method: "POST",
      chunks: [Buffer.alloc(MAX_REQUEST_BODY_BYTES), Buffer.alloc(1)],
      authenticated: false,
    });
    assert.equal(streamed.status, 413);

    const socket = new FakeSocket();
    const req = {
      headers: { upgrade: "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
    } as IncomingMessage;
    const ws = acceptWebSocket(req, socket as unknown as Socket, Buffer.alloc(0));
    assert.ok(ws);
    const header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 0xff;
    header.writeBigUInt64BE(BigInt(MAX_WEBSOCKET_FRAME_BYTES + 1), 2);
    socket.emit("data", header);
    assert.equal(ws.readyState, "closed");
    assert.equal(socket.destroyed, true);
  });

  it("rejects invalid Cookie and URL escapes on upgrade without throwing", () => {
    const socket = new FakeSocket();
    const req = {
      url: "/api/v1/events",
      headers: {
        host: "127.0.0.1:0",
        origin: "http://127.0.0.1:0",
        cookie: `${SESSION_COOKIE}=%ZZ`,
      },
    } as IncomingMessage;
    assert.doesNotThrow(() => {
      daemon.server.emit("upgrade", req, socket as unknown as Socket, Buffer.alloc(0));
    });
    assert.equal(socket.destroyed, true);
    assert.match(String(socket.writes[0]), /^HTTP\/1\.1 400 Bad Request/);

    const pathSocket = new FakeSocket();
    const pathReq = {
      url: "/api/v1/live/%FF",
      headers: {
        host: "127.0.0.1:0",
        origin: "http://127.0.0.1:0",
        cookie,
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    } as IncomingMessage;
    assert.doesNotThrow(() => {
      daemon.server.emit(
        "upgrade",
        pathReq,
        pathSocket as unknown as Socket,
        Buffer.alloc(0),
      );
    });
    assert.equal(pathSocket.destroyed, true);
    assert.match(String(pathSocket.writes[0]), /^HTTP\/1\.1 400 Bad Request/);
  });
});
