import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { isDnszEnabled, startProxy } from "../../../src/proxy/proxy.ts";

function listenReady(server: { listening: boolean; once: Function }): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
}

async function withHealth(
  envVal: string | undefined,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const prev = process.env.PROXY_DNSZ;
  if (envVal === undefined) delete process.env.PROXY_DNSZ;
  else process.env.PROXY_DNSZ = envVal;
  const started = startProxy({
    listenHost: "127.0.0.1",
    proxyPort: 0,
    healthPort: 0,
    dnsPort: 0,
  });
  try {
    await listenReady(started.healthServer);
    const addr = started.healthServer.address() as AddressInfo;
    await fn(addr.port);
  } finally {
    await started.close();
    if (prev === undefined) delete process.env.PROXY_DNSZ;
    else process.env.PROXY_DNSZ = prev;
  }
}

describe("proxy /dnsz", () => {
  afterEach(() => {
    delete process.env.PROXY_DNSZ;
  });

  it("flag unset means disabled", () => {
    assert.equal(isDnszEnabled({}), false);
    assert.equal(isDnszEnabled({ PROXY_DNSZ: "0" }), false);
    assert.equal(isDnszEnabled({ PROXY_DNSZ: "1" }), true);
  });

  it("GET /dnsz with flag unset returns 404", async () => {
    await withHealth(undefined, async (port) => {
      const r = await fetch(`http://127.0.0.1:${port}/dnsz`);
      assert.equal(r.status, 404);
    });
  });

  it("GET /dnsz with PROXY_DNSZ=1 on loopback returns 200", async () => {
    await withHealth("1", async (port) => {
      const r = await fetch(`http://127.0.0.1:${port}/dnsz`);
      assert.equal(r.status, 200);
      const body = (await r.json()) as { forwarded: number; names: unknown };
      assert.equal(body.forwarded, 0);
      assert.ok(Array.isArray(body.names));
    });
  });

  it("dnsPort 53 bind failure is handled and close() does not throw", async () => {
    const started = startProxy({
      listenHost: "127.0.0.1",
      proxyPort: 0,
      healthPort: 0,
      dnsPort: 53,
    });
    try {
      await listenReady(started.healthServer);
      const dns = await started.dnsReady.catch(() => null);
      if (process.getuid?.() !== 0) {
        assert.equal(dns, null);
      }
    } finally {
      await started.close();
    }
  });
});
