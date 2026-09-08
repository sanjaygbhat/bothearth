import assert from "node:assert/strict";
import http from "node:http";
import { PassThrough } from "node:stream";
import { it, mock } from "node:test";
import { startProxy, type AccessLine } from "../../../src/proxy/proxy.ts";

it("logs an HTTP upstream failure as denied with its reason", async () => {
  const previous = process.env.PROXY_ACCESS_LOG_PATH;
  const output: string[] = [];
  process.env.PROXY_ACCESS_LOG_PATH = "none";
  mock.method(
    process.stdout,
    "write",
    ((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write,
  );
  mock.method(
    http.Server.prototype,
    "listen",
    (function (this: http.Server) {
      return this;
    }) as typeof http.Server.prototype.listen,
  );
  mock.method(
    http,
    "request",
    (() => {
      const upstream = new PassThrough();
      queueMicrotask(() => upstream.emit("error", new Error("upstream failed")));
      return upstream;
    }) as unknown as typeof http.request,
  );

  try {
    const started = startProxy({
      dnsPort: 0,
      policy: { mode: "open", allowlist: [], allowedPorts: [1] },
    });
    const socket = new PassThrough();
    Object.assign(socket, { setTimeout: () => socket });
    const req = new http.IncomingMessage(socket as never);
    req.method = "GET";
    req.url = "http://1.1.1.1:1/audit";
    const res = new http.ServerResponse(req);
    res.assignSocket(socket as never);
    const finished = new Promise<void>((resolve) => res.once("finish", resolve));

    started.proxyServer.emit("request", req, res);
    req.push(null);
    await finished;
    assert.equal(res.statusCode, 502);
    socket.destroy();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const text = output.find((chunk) => chunk.includes('"host":"1.1.1.1"'));
    assert.ok(text);
    const line = JSON.parse(text) as AccessLine;
    assert.equal(line.allowed, false);
    assert.equal(line.reason, "upstream-error");
  } finally {
    mock.restoreAll();
    if (previous === undefined) delete process.env.PROXY_ACCESS_LOG_PATH;
    else process.env.PROXY_ACCESS_LOG_PATH = previous;
  }
});
