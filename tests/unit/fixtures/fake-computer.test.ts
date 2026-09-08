import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeComputerServer,
  FIXTURE_JPEG,
} from "../../fixtures/fake-computer-server.ts";
import {
  encodeRpcFrame,
  encodeLiveStdioFrame,
  readStdioFrame,
  STDIO_RPC_TYPE,
  STDIO_LIVE_TYPE,
} from "../../../src/protocol/stdio.ts";
import type { ScreencastFrameHeader } from "../../../src/types/contracts.ts";
import { withDockerLock } from "../../docker-int/lock.ts";
import { readerFrom } from "../../helpers/stdio.ts";

type ToolRes = {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
};

describe("fake-computer-server framing", () => {
  it("RPC round-trip over length-prefixed stdio", () => {
    const out: Uint8Array[] = [];
    const fake = new FakeComputerServer({ write: (f) => out.push(f) });
    fake.feed(
      encodeRpcFrame({
        jsonrpc: "2.0",
        id: 1,
        method: "browser_snapshot",
        params: {},
      }),
    );
    assert.equal(out.length, 1);
    const decoded = readStdioFrame(readerFrom(out[0]!));
    assert.equal(decoded.type, STDIO_RPC_TYPE);
    if (decoded.type === STDIO_RPC_TYPE) {
      const msg = decoded.message as { id: number; result: ToolRes };
      assert.equal(msg.id, 1);
      assert.equal(msg.result.ok, true);
      assert.ok(typeof msg.result.data?.snapshot_id === "string");
      assert.ok(Array.isArray(msg.result.data?.refs));
    }
    fake.stop();
  });

  it("LIVE frame encode/decode matches protocol", () => {
    const header: ScreencastFrameHeader = {
      v: 1,
      seq: 1,
      ts: 0,
      mime: "image/jpeg",
      mode: "agent",
      epoch: 1,
      target: "p0",
      viewport: { w: 800, h: 600, dpr: 1 },
      meta: {
        offsetTop: 0,
        pageScaleFactor: 1,
        deviceWidth: 800,
        deviceHeight: 600,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
      },
    };
    const frame = encodeLiveStdioFrame(header, FIXTURE_JPEG);
    const decoded = readStdioFrame(readerFrom(frame));
    assert.equal(decoded.type, STDIO_LIVE_TYPE);
    if (decoded.type === STDIO_LIVE_TYPE) {
      assert.equal(decoded.header.seq, 1);
      assert.deepEqual(Buffer.from(decoded.payload), Buffer.from(FIXTURE_JPEG));
    }
  });

  it("site snapshot changes after click + type", () => {
    const fake = new FakeComputerServer({ write: () => {} });
    const s0 = fake.handleRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "browser_snapshot",
      params: {},
    });
    const d0 = (s0.result as ToolRes).data!;
    const click = fake.handleRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "browser_click",
      params: {
        snapshot_id: d0.snapshot_id,
        ref: (d0.refs as string[])[0],
        button: "left",
        double_click: false,
      },
    });
    assert.equal((click.result as ToolRes).ok, true);
    const s1 = fake.handleRpc({
      jsonrpc: "2.0",
      id: 3,
      method: "browser_snapshot",
      params: {},
    });
    const d1 = (s1.result as ToolRes).data!;
    assert.notEqual(d1.snapshot_id, d0.snapshot_id);
    assert.match(String(d1.url), /login|Login/i);

    const passRef =
      (d1.refs as string[]).find((r) => String(d1.yaml).includes(`[ref=${r}]`) && String(d1.yaml).toLowerCase().includes("password")) ??
      (d1.refs as string[])[1];
    const typed = fake.handleRpc({
      jsonrpc: "2.0",
      id: 4,
      method: "browser_type",
      params: {
        snapshot_id: d1.snapshot_id,
        ref: passRef,
        text: "secret",
        submit: false,
        slowly: false,
      },
    });
    assert.equal((typed.result as ToolRes).ok, true);
    const s2 = fake.handleRpc({
      jsonrpc: "2.0",
      id: 5,
      method: "browser_snapshot",
      params: {},
    });
    const d2 = (s2.result as ToolRes).data!;
    assert.notEqual(d2.snapshot_id, d1.snapshot_id);
    assert.match(String(d2.yaml), /\*|secret|value=/i);
    fake.stop();
  });
});

describe("fake-computer-server takeover", () => {
  it("HUMAN refuses non-exempt tools with E_TAKEOVER_BUSY; live.* ok", () => {
    const fake = new FakeComputerServer({ write: () => {} });
    const req = fake.handleRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "request_takeover",
      params: { reason: "password", category: "password" },
    });
    assert.equal((req.result as ToolRes).ok, true);
    const grant = fake.handleRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "takeover.grant",
      params: {},
    });
    assert.equal((grant.result as ToolRes).data?.state, "human");

    const busy = fake.handleRpc({
      jsonrpc: "2.0",
      id: 3,
      method: "browser_snapshot",
      params: {},
    });
    const err = busy.result as ToolRes;
    assert.equal(err.ok, false);
    assert.equal(err.error?.code, "E_TAKEOVER_BUSY");

    const status = fake.handleRpc({
      jsonrpc: "2.0",
      id: 4,
      method: "takeover_status",
      params: { takeover_id: (req.result as ToolRes).data?.takeover_id },
    });
    assert.equal((status.result as ToolRes).ok, true);

    const relay = fake.handleRpc({
      jsonrpc: "2.0",
      id: 5,
      method: "live.pointer",
      params: { x: 10, y: 20 },
    });
    assert.equal((relay.result as ToolRes).ok, true);
    fake.stop();
  });
});

describe("fake-computer-server path jail", () => {
  it("allows /workspace writes; rejects escape + profile paths", () => {
    const root = mkdtempSync(join(tmpdir(), "mb-jail-"));
    const fake = new FakeComputerServer({ write: () => {}, workspaceRoot: root });
    const okWrite = fake.handleRpc({
      jsonrpc: "2.0",
      id: 1,
      method: "files_write",
      params: { path: "/workspace/out.txt", content: "hi", mkdir: true },
    });
    assert.equal((okWrite.result as ToolRes).ok, true);
    assert.equal(readFileSync(join(root, "out.txt"), "utf8"), "hi");

    const escape = fake.handleRpc({
      jsonrpc: "2.0",
      id: 2,
      method: "files_read",
      params: { path: "/workspace/../etc/passwd", offset: null, limit: null },
    });
    assert.equal((escape.result as ToolRes).error?.code, "E_POLICY");

    const profile = fake.handleRpc({
      jsonrpc: "2.0",
      id: 3,
      method: "files_read",
      params: {
        path: "/home/browser/.config/Cookies",
        offset: null,
        limit: null,
      },
    });
    assert.equal((profile.result as ToolRes).error?.code, "E_POLICY");
    fake.stop();
  });
});

describe("docker-int lock helper", () => {
  it("serializes exclusive holders", async () => {
    const lockPath = join(mkdtempSync(join(tmpdir(), "mb-lock-")), "t.lock");
    const order: number[] = [];
    await Promise.all([
      withDockerLock(async () => {
        order.push(1);
        await new Promise((r) => setTimeout(r, 40));
        order.push(2);
      }, lockPath),
      withDockerLock(async () => {
        order.push(3);
      }, lockPath),
    ]);
    assert.deepEqual(order, [1, 2, 3]);
  });
});
