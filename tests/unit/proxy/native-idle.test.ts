import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { Duplex } from "node:stream";
import { test, mock } from "node:test";
import { startProxy } from "../../../src/proxy/proxy.ts";
import { until } from "../../helpers/until.ts";

test("native CONNECT leaves idle deadlines to its client unless the owner configured one", async () => {
  const original = process.env.IDLE_TIMEOUT_MS;
  delete process.env.IDLE_TIMEOUT_MS;
  const idle: number[] = [];
  const socket = () => Object.assign(new Duplex({ read() {}, write(_data, _encoding, done) { done(); } }),
    { setTimeout(ms: number) { idle.push(ms); return this; }, remoteAddress: "1.1.1.1" });
  mock.method(http.Server.prototype, "listen", function (this: http.Server) { return this; });
  let upstream: ReturnType<typeof socket>;
  mock.method(net, "connect", (() => { upstream = socket(); queueMicrotask(() => upstream.emit("connect")); return upstream; }) as typeof net.connect);
  try {
    for (const limit of [undefined, 230_000]) {
      const proxy = startProxy({ dnsPort: 0, idleTimeoutMs: limit, policy: { mode: "open", allowlist: [], allowedPorts: [443] } });
      const client = socket();
      const req = new http.IncomingMessage(client as never);
      req.url = "1.1.1.1:443";
      const before = idle.length;
      proxy.proxyServer.emit("connect", req, client, Buffer.alloc(0));
      await until(() => idle.length === before + 2);
      assert.deepEqual(idle.slice(before), [limit ?? 0, limit ?? 0]);
      assert.equal(client.destroyed, false);
      assert.equal(upstream!.destroyed, false);
      client.destroy(); upstream!.destroy();
      await proxy.close().catch(error => { if (error.code !== "ERR_SERVER_NOT_RUNNING") throw error; });
    }
  } finally {
    mock.restoreAll();
    if (original === undefined) delete process.env.IDLE_TIMEOUT_MS; else process.env.IDLE_TIMEOUT_MS = original;
  }
});
