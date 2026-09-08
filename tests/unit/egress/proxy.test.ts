import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalizeIpLiteral,
  evaluateDestination,
  extractMappedIpv4,
  hostMatchesAllowlist,
  isDeniedAddress,
  type LookupFn,
  type PolicyConfig,
} from "../../../src/proxy/policy.ts";

const openPolicy: PolicyConfig = {
  mode: "open",
  allowlist: [],
  allowedPorts: [80, 443],
};

const strictPolicy: PolicyConfig = {
  mode: "strict",
  allowlist: ["example.com", "*.example.org"],
  allowedPorts: [80, 443],
};

describe("canonicalizeIpLiteral", () => {
  it("parses normal IPv4/IPv6", () => {
    assert.equal(canonicalizeIpLiteral("127.0.0.1"), "127.0.0.1");
    assert.equal(canonicalizeIpLiteral("[::1]"), "::1");
    assert.equal(canonicalizeIpLiteral("::1"), "::1");
  });

  it("parses decimal/hex/octal single-number IPv4 tricks", () => {
    assert.equal(canonicalizeIpLiteral("0x7f000001"), "127.0.0.1");
    assert.equal(canonicalizeIpLiteral("2130706433"), "127.0.0.1");
    assert.equal(canonicalizeIpLiteral("017700000001"), "127.0.0.1");
  });

  it("parses dotted hex/octal components", () => {
    assert.equal(canonicalizeIpLiteral("0x7f.0.0.1"), "127.0.0.1");
    assert.equal(canonicalizeIpLiteral("0177.0.0.1"), "127.0.0.1");
  });

  it("returns null for hostnames", () => {
    assert.equal(canonicalizeIpLiteral("example.com"), null);
    assert.equal(canonicalizeIpLiteral("localtest.me"), null);
  });
});

describe("extractMappedIpv4 / IPv4-mapped IPv6", () => {
  it("extracts mapped loopback", () => {
    assert.equal(extractMappedIpv4("::ffff:127.0.0.1"), "127.0.0.1");
    assert.equal(extractMappedIpv4("::ffff:7f00:1"), "127.0.0.1");
  });

  it("denies mapped private addresses", () => {
    const d = isDeniedAddress("::ffff:10.0.0.1");
    assert.equal(d.denied, true);
    assert.match(d.reason, /rfc1918/);
  });
});

describe("isDeniedAddress private ranges", () => {
  it("denies RFC1918, loopback, link-local, metadata", () => {
    for (const ip of [
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "127.0.0.1",
      "127.255.0.1",
      "169.254.169.254",
      "169.254.0.1",
    ]) {
      assert.equal(isDeniedAddress(ip).denied, true, ip);
    }
  });

  it("allows public IPv4", () => {
    assert.equal(isDeniedAddress("93.184.216.34").denied, false);
    assert.equal(isDeniedAddress("1.1.1.1").denied, false);
    assert.equal(isDeniedAddress("8.8.8.8").denied, false);
  });

  it("denies IPv6 loopback, ULA, link-local", () => {
    assert.equal(isDeniedAddress("::1").denied, true);
    assert.equal(isDeniedAddress("fc00::1").denied, true);
    assert.equal(isDeniedAddress("fd12:3456:789a::1").denied, true);
    assert.equal(isDeniedAddress("fe80::1").denied, true);
  });

  it("allows public IPv6", () => {
    assert.equal(isDeniedAddress("2001:4860:4860::8888").denied, false);
  });

  it("does not treat 172.32.0.1 as RFC1918", () => {
    assert.equal(isDeniedAddress("172.32.0.1").denied, false);
  });
});

describe("hostMatchesAllowlist", () => {
  it("matches exact and wildcard", () => {
    assert.equal(hostMatchesAllowlist("example.com", ["example.com"]), true);
    assert.equal(hostMatchesAllowlist("a.example.org", ["*.example.org"]), true);
    assert.equal(hostMatchesAllowlist("evil.com", ["example.com"]), false);
  });
});

describe("evaluateDestination", () => {
  it("denies disallowed ports", async () => {
    for (const port of [22, 25, 3389, 5900]) {
      const d = await evaluateDestination("1.1.1.1", port, openPolicy);
      assert.equal(d.allowed, false, String(port));
      assert.match(d.reason, /denied-port/);
    }
  });

  it("denies private IP literals", async () => {
    const d = await evaluateDestination("169.254.169.254", 80, openPolicy);
    assert.equal(d.allowed, false);
  });

  it("denies IP trick forms of loopback", async () => {
    for (const h of ["0x7f000001", "2130706433", "017700000001"]) {
      const d = await evaluateDestination(h, 80, openPolicy);
      assert.equal(d.allowed, false, h);
    }
  });

  it("denies hostname that resolves to private (DNS)", async () => {
    const lookup: LookupFn = async () => [
      { address: "127.0.0.1", family: 4 },
    ];
    const d = await evaluateDestination("localtest.me", 80, openPolicy, lookup);
    assert.equal(d.allowed, false);
    assert.match(d.reason, /loopback/);
  });

  it("allows hostname resolving only to public IPs", async () => {
    const lookup: LookupFn = async () => [
      { address: "93.184.216.34", family: 4 },
    ];
    const d = await evaluateDestination("example.com", 443, openPolicy, lookup);
    assert.equal(d.allowed, true);
    assert.deepEqual(d.addresses, ["93.184.216.34"]);
  });

  it("denies if any resolved address is private", async () => {
    const lookup: LookupFn = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ];
    const d = await evaluateDestination("evil.example", 443, openPolicy, lookup);
    assert.equal(d.allowed, false);
  });

  it("DNS rebinding re-check: second lookup flips to private → deny", async () => {
    let n = 0;
    const lookup: LookupFn = async () => {
      n += 1;
      if (n === 1) return [{ address: "93.184.216.34", family: 4 }];
      return [{ address: "169.254.169.254", family: 4 }];
    };
    const first = await evaluateDestination("rebind.test", 443, openPolicy, lookup);
    assert.equal(first.allowed, true);
    const second = await evaluateDestination("rebind.test", 443, openPolicy, lookup);
    assert.equal(second.allowed, false);
    assert.match(second.reason, /link-local|169/);
  });

  it("strict mode requires allowlist", async () => {
    const lookup: LookupFn = async () => [
      { address: "93.184.216.34", family: 4 },
    ];
    const denied = await evaluateDestination("evil.com", 443, strictPolicy, lookup);
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, "denied-allowlist");
    const ok = await evaluateDestination("example.com", 443, strictPolicy, lookup);
    assert.equal(ok.allowed, true);
  });
});

/*
 * Best-effort / listed for SECURITY-CHECKLIST egress bypass comments:
 * - Raw TCP/UDP past proxy (covered in scripts/egress-bypass.sh cases 4–6,9 via internal:true)
 * - IPv6 direct egress (case 6)
 * - DoH direct (case 9)
 * - QUIC (Chromium proxy policy; not exercised here)
 * - Abuse of allowed public hosts (out of scope for IP deny policy)
 */
