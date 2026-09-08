import assert from "node:assert/strict";
import dgram from "node:dgram";
import { describe, it } from "node:test";
import {
  createDnsSinkhole,
  encodeQuery,
  nxdomainResponse,
  parseQuestionName,
  startDnsSinkhole,
} from "../../../src/proxy/dns.ts";
import { evaluateDestination, type PolicyConfig } from "../../../src/proxy/policy.ts";

const openPolicy: PolicyConfig = {
  mode: "open",
  allowlist: [],
  allowedPorts: [80, 443],
};

describe("dns sinkhole", () => {
  it("parses QNAME from a standard query", () => {
    const q = encodeQuery("abc123.exfil-test.invalid");
    assert.equal(parseQuestionName(q), "abc123.exfil-test.invalid");
  });

  it("NXDOMAIN response never sets RA and does not copy extra sections", () => {
    const q = encodeQuery("leak.exfil-test.invalid");
    const r = nxdomainResponse(q);
    assert.ok(r);
    assert.equal((r![2]! & 0x80) !== 0, true, "QR");
    assert.equal((r![3]! & 0x80) !== 0, false, "RA must be 0");
    assert.equal(r![3]! & 0x0f, 3, "RCODE NXDOMAIN");
    assert.equal(r!.readUInt16BE(6), 0);
  });

  it("records names and forwarded stays 0", () => {
    const h = createDnsSinkhole();
    h.record("aa.exfil-test.invalid");
    h.record("aa.exfil-test.invalid");
    h.record("bb.exfil-test.invalid");
    const s = h.stats();
    assert.equal(s.queries, 3);
    assert.equal(s.forwarded, 0);
    assert.deepEqual(s.names, ["aa.exfil-test.invalid", "bb.exfil-test.invalid"]);
  });

  it("bounds remembered names and can re-list an evicted name", () => {
    const h = createDnsSinkhole();
    for (let i = 0; i < 65; i++) h.record(`name-${i}.example.com`);
    assert.equal(h.stats().names.length, 64);
    assert.equal(h.stats().names.includes("name-0.example.com"), false);

    h.record("name-0.example.com");
    assert.equal(h.stats().names.length, 64);
    assert.equal(h.stats().names.at(-1), "name-0.example.com");
  });

  it("UDP sinkhole answers NXDOMAIN and does not send upstream", async () => {
    const server = await startDnsSinkhole(0, "127.0.0.1");
    const port = server.udpPort();
    const q = encodeQuery("hexdeadbeef.exfil-test.invalid");
    const client = dgram.createSocket("udp4");
    const reply = await new Promise<Buffer>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("dns timeout")), 2000);
      client.once("message", (msg) => {
        clearTimeout(t);
        resolve(msg);
      });
      client.send(q, port, "127.0.0.1");
    });
    client.close();
    assert.equal(reply[3]! & 0x0f, 3);
    const st = server.stats();
    assert.equal(st.forwarded, 0);
    assert.ok(st.names.includes("hexdeadbeef.exfil-test.invalid"));
    await server.close();
  });
});

describe("reserved TLD deny without lookup", () => {
  it("denies .invalid / .test without calling lookup", async () => {
    let lookups = 0;
    const lookup = async () => {
      lookups += 1;
      return [{ address: "1.1.1.1", family: 4 }];
    };
    for (const host of [
      "abc.exfil-test.invalid",
      "a.b.c.d.e.f.g.exfil-test.invalid",
    ]) {
      const d = await evaluateDestination(host, 443, openPolicy, lookup);
      assert.equal(d.allowed, false, host);
      assert.match(d.reason, /reserved-tld/);
    }
    assert.equal(lookups, 0);
  });

  it("still looks up ordinary public names", async () => {
    let lookups = 0;
    const lookup = async () => {
      lookups += 1;
      return [{ address: "93.184.216.34", family: 4 }];
    };
    const d = await evaluateDestination("example.com", 443, openPolicy, lookup);
    assert.equal(d.allowed, true);
    assert.equal(lookups, 1);
  });
});
