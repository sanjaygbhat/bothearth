/**
 * Internal /24 allocation from a used-set, persist, mock docker probe.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { DockerCli } from "../../../src/sandbox/docker.ts";
import {
  composeComputerEnv,
  renderProductComposeYaml,
} from "../../../src/sandbox/compose.ts";
import {
  collectPersistedInternalSubnets,
  internalDnsPlan,
  loadPersistedInternalDnsPlan,
  networkCreateArgs,
  octetFromInternalSubnet,
  parseUsedInternalSubnets,
  probeUsedInternalSubnets,
  resolveInternalDnsPlan,
} from "../../../src/sandbox/flags.ts";

function fakeCli(ls: string, inspect: string): DockerCli {
  return {
    binary: "docker",
    async run(args: string[]) {
      if (args[0] === "network" && args[1] === "ls") return ls;
      if (args[0] === "network" && args[1] === "inspect") return inspect;
      throw new Error(`unexpected argv: ${args.join(" ")}`);
    },
    runSync() {
      throw new Error("runSync unused");
    },
    spawn() {
      throw new Error("spawn unused");
    },
  };
}

describe("internal DNS used-set", () => {
  it("30 names yield 30 distinct subnets with a fake used-set", () => {
    const used = new Set<string>();
    const subnets = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const plan = internalDnsPlan(`comp-${i}`, used);
      used.add(plan.subnet);
      subnets.add(plan.subnet);
    }
    assert.equal(subnets.size, 30);
    for (const s of subnets) {
      const oct = octetFromInternalSubnet(s);
      assert.ok(oct !== undefined && oct >= 1 && oct <= 254, s);
    }
  });

  it("networkCreateArgs uses the allocated plan subnet", () => {
    const plan = internalDnsPlan("demo", ["10.233.1.0/24"]);
    const args = networkCreateArgs("demo", "internal", plan);
    assert.ok(args.includes(plan.subnet));
    assert.ok(args.includes("--subnet"));
  });

  it("skips an occupied hash octet", () => {
    const first = internalDnsPlan("demo");
    const second = internalDnsPlan("demo", [first.subnet]);
    assert.notEqual(second.subnet, first.subnet);
    assert.equal(second.proxyIp, second.subnet.replace(/\.0\/24$/, ".2"));
  });

  it("probeUsedInternalSubnets parses docker inspect via mocked client", async () => {
    const inspect = JSON.stringify([
      { IPAM: { Config: [{ Subnet: "10.233.4.0/24" }] } },
      { IPAM: { Config: [{ Subnet: "172.17.0.0/16" }] } },
      { IPAM: { Config: [{ Subnet: "10.233.9.0/24" }] } },
    ]);
    const used = await probeUsedInternalSubnets(fakeCli("abc\ndef\n", inspect));
    assert.deepEqual([...used].sort(), ["10.233.4.0/24", "10.233.9.0/24"]);
    assert.deepEqual(
      [...parseUsedInternalSubnets(inspect)].sort(),
      ["10.233.4.0/24", "10.233.9.0/24"],
    );
  });

  it("persists per computer and reuses the same subnet", () => {
    const root = mkdtempSync(join(tmpdir(), "mb-dns-"));
    mkdirSync(join(root, "alpha", "workspace"), { recursive: true });
    const ws = join(root, "alpha", "workspace");
    const used = new Set<string>(["10.233.1.0/24"]);
    const a = resolveInternalDnsPlan("alpha", used, ws);
    const b = resolveInternalDnsPlan("alpha", used, ws);
    assert.deepEqual(a, b);
    const raw = JSON.parse(readFileSync(join(root, "alpha", "internal-dns.json"), "utf8"));
    assert.equal(raw.subnet, a.subnet);
    assert.deepEqual(loadPersistedInternalDnsPlan(ws), a);
    const collected = collectPersistedInternalSubnets(root);
    assert.ok(collected.has(a.subnet));
  });

  it("product compose template interpolates INTERNAL_SUBNET with defaults", () => {
    const yaml = renderProductComposeYaml();
    assert.match(yaml, /\$\{INTERNAL_SUBNET:-10\.233\.77\.0\/24\}/);
    assert.match(yaml, /\$\{INTERNAL_PROXY_IP:-10\.233\.77\.2\}/);
    assert.doesNotMatch(yaml, /subnet:\s*10\.233\.77\.0\/24/);
  });

  it("probeUsedInternalSubnets tolerates one vanished id and still yields a plan", async () => {
    const cli: DockerCli = {
      binary: "docker",
      async run(args: string[]) {
        if (args[0] === "network" && args[1] === "ls") return "aaa\nbbb\nccc\n";
        if (args[0] === "network" && args[1] === "inspect") {
          const id = args[2];
          if (id === "bbb") throw new Error("Error: no such network");
          if (id === "aaa") {
            return JSON.stringify([{ IPAM: { Config: [{ Subnet: "10.233.4.0/24" }] } }]);
          }
          if (id === "ccc") {
            return JSON.stringify([{ IPAM: { Config: [{ Subnet: "10.233.9.0/24" }] } }]);
          }
        }
        throw new Error(`unexpected argv: ${args.join(" ")}`);
      },
      runSync() {
        throw new Error("runSync unused");
      },
      spawn() {
        throw new Error("spawn unused");
      },
    };
    const used = await probeUsedInternalSubnets(cli);
    assert.deepEqual([...used].sort(), ["10.233.4.0/24", "10.233.9.0/24"]);
    const plan = internalDnsPlan("drift-g3", used);
    assert.ok(plan.subnet);
    assert.notEqual(plan.subnet, "10.233.4.0/24");
    assert.notEqual(plan.subnet, "10.233.9.0/24");
  });

  it("reallocates a persisted plan that collides with used", () => {
    const root = mkdtempSync(join(tmpdir(), "mb-dns-col-"));
    mkdirSync(join(root, "alpha", "workspace"), { recursive: true });
    const ws = join(root, "alpha", "workspace");
    const first = resolveInternalDnsPlan("alpha", [], ws);
    const next = resolveInternalDnsPlan("alpha", [first.subnet], ws);
    assert.notEqual(next.subnet, first.subnet);
  });

  it("composeComputerEnv carries distinct allocated subnets per name", () => {
    const used = new Set<string>();
    const a = internalDnsPlan("alpha-two", used);
    used.add(a.subnet);
    const b = internalDnsPlan("beta-two", used);
    const ea = composeComputerEnv("alpha-two", "/tmp/a", a);
    const eb = composeComputerEnv("beta-two", "/tmp/b", b);
    assert.equal(ea.INTERNAL_SUBNET, a.subnet);
    assert.equal(eb.INTERNAL_SUBNET, b.subnet);
    assert.notEqual(ea.INTERNAL_SUBNET, eb.INTERNAL_SUBNET);
    assert.equal(ea.INTERNAL_PROXY_IP, a.proxyIp);
  });
});
