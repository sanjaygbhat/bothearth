import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateDestination,
  isNeverAllowedHostname,
  type LookupFn,
  type PolicyConfig,
} from "../../../src/proxy/policy.ts";

const openPolicy: PolicyConfig = {
  mode: "open",
  allowlist: [],
  allowedPorts: [80, 443],
};

const FIVE = [
  "metadata.google.internal",
  "metadata.goog",
  "fd00:ec2::254",
  "169.254.170.2",
  "100.100.100.200",
] as const;

describe("proxy never-list", () => {
  it("isNeverAllowedHostname covers OpenBot metadata names", () => {
    for (const h of FIVE) assert.equal(isNeverAllowedHostname(h), true, h);
    assert.equal(isNeverAllowedHostname("169.254.169.254"), true);
    assert.equal(isNeverAllowedHostname("metadata.google.internal."), true);
    assert.equal(isNeverAllowedHostname("METADATA.GOOG"), true);
    assert.equal(isNeverAllowedHostname("example.com"), false);
  });

  it("five names denied before any DNS lookup (DNS spy not called)", async () => {
    let calls = 0;
    const lookup: LookupFn = async () => {
      calls += 1;
      return [{ address: "8.8.8.8", family: 4 }];
    };
    for (const host of FIVE) {
      calls = 0;
      const d = await evaluateDestination(host, 443, openPolicy, lookup);
      assert.equal(d.allowed, false, host);
      assert.equal(d.reason, "denied-host:never", host);
      assert.equal(calls, 0, `lookup must not run for ${host}`);
    }
  });

  it("numeric metadata addresses still deny (CIDR regression lock)", async () => {
    let calls = 0;
    const lookup: LookupFn = async () => {
      calls += 1;
      return [{ address: "8.8.8.8", family: 4 }];
    };
    for (const host of ["169.254.169.254", "169.254.170.2", "100.100.100.200", "fd00:ec2::254"]) {
      calls = 0;
      const d = await evaluateDestination(host, 80, openPolicy, lookup);
      assert.equal(d.allowed, false, host);
      assert.equal(calls, 0, host);
    }
  });
});
