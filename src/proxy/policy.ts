import dns from "node:dns/promises";
import net from "node:net";
import { readFileSync } from "node:fs";

type PolicyMode = "open" | "strict";

export type PolicyConfig = {
  mode: PolicyMode;
  allowlist: string[];
  allowedPorts: number[];
};

export type LookupFn = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

type Decision = {
  allowed: boolean;
  reason: string;
  host: string;
  port: number;
  addresses: string[];
};

const DEFAULT_PORTS = [80, 443];

/** Default deny: RFC1918, loopback, link-local, ULA, metadata range. */
const V4_DENY: Array<{ base: string; bits: number; label: string }> = [
  { base: "0.0.0.0", bits: 8, label: "this-net/8" },
  { base: "10.0.0.0", bits: 8, label: "rfc1918-10/8" },
  { base: "100.64.0.0", bits: 10, label: "cgnat-100.64/10" },
  { base: "127.0.0.0", bits: 8, label: "loopback/8" },
  { base: "169.254.0.0", bits: 16, label: "link-local/16" },
  { base: "172.16.0.0", bits: 12, label: "rfc1918-172.16/12" },
  { base: "192.168.0.0", bits: 16, label: "rfc1918-192.168/16" },
  { base: "192.0.0.0", bits: 24, label: "ietf-protocol-192.0.0/24" },
  { base: "192.0.2.0", bits: 24, label: "documentation-192.0.2/24" },
  { base: "192.88.99.0", bits: 24, label: "6to4-relay-anycast" },
  { base: "198.18.0.0", bits: 15, label: "benchmarking-198.18/15" },
  { base: "198.51.100.0", bits: 24, label: "documentation-198.51.100/24" },
  { base: "203.0.113.0", bits: 24, label: "documentation-203.0.113/24" },
  { base: "224.0.0.0", bits: 4, label: "multicast/4" },
  { base: "240.0.0.0", bits: 4, label: "reserved/4" },
];

const V6_DENY: Array<{ base: string; bits: number; label: string }> = [
  { base: "::", bits: 128, label: "unspecified-v6" },
  { base: "::1", bits: 128, label: "loopback-v6" },
  { base: "fc00::", bits: 7, label: "ula-fc00::/7" },
  { base: "fe80::", bits: 10, label: "link-local-fe80::/10" },
  { base: "fec0::", bits: 10, label: "site-local-fec0::/10" },
  { base: "64:ff9b::", bits: 96, label: "nat64-wkp" },
  { base: "2001:db8::", bits: 32, label: "documentation-v6" },
  { base: "2002::", bits: 16, label: "6to4" },
  { base: "ff00::", bits: 8, label: "multicast-v6" },
];

function defaultPolicy(): PolicyConfig {
  return { mode: "open", allowlist: [], allowedPorts: [...DEFAULT_PORTS] };
}

export function loadPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PolicyConfig {
  const base = defaultPolicy();
  const path = env.PROXY_POLICY_PATH;
  const inline = env.PROXY_POLICY_JSON;
  let raw: unknown = null;
  if (path) {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } else if (inline) {
    raw = JSON.parse(inline);
  }
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;
  const mode = obj.mode === "strict" ? "strict" : "open";
  const allowlist = Array.isArray(obj.allowlist)
    ? obj.allowlist.filter((x): x is string => typeof x === "string")
    : [];
  const allowedPorts = Array.isArray(obj.allowedPorts)
    ? obj.allowedPorts.filter((x): x is number => typeof x === "number")
    : DEFAULT_PORTS;
  return { mode, allowlist, allowedPorts };
}

function ipv4ToInt(ip: string): number {
  const p = ip.split(".").map((x) => Number(x));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`bad ipv4: ${ip}`);
  }
  return (((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!) >>> 0;
}

function intToIpv4(n: number): string {
  const x = n >>> 0;
  return `${(x >>> 24) & 255}.${(x >>> 16) & 255}.${(x >>> 8) & 255}.${x & 255}`;
}

function parseIpv6Bytes(ip: string): Uint8Array | null {
  // Handle IPv4-mapped and dotted-quad tail via net.isIP after expand attempt.
  if (net.isIP(ip) !== 6 && !ip.includes(":")) return null;
  let s = ip.toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);

  // ::ffff:1.2.3.4 or ::ffff:aabb:ccdd handled below via mapped extraction.
  const v4Tail = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Tail) {
    const head = v4Tail[1]!;
    const v4 = v4Tail[2]!;
    const n = ipv4ToInt(v4);
    const hex = ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
    s = head + hex;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parseSide = (side: string): number[] => {
    if (!side) return [];
    return side.split(":").filter(Boolean).map((h) => {
      const v = parseInt(h, 16);
      if (!Number.isFinite(v) || v < 0 || v > 0xffff) throw new Error("bad");
      return v;
    });
  };
  let left: number[];
  let right: number[];
  try {
    left = parseSide(halves[0] ?? "");
    right = halves.length === 2 ? parseSide(halves[1] ?? "") : [];
  } catch {
    return null;
  }
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const words = [...left, ...Array(missing).fill(0), ...right];
  if (words.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    out[i * 2] = (words[i]! >> 8) & 0xff;
    out[i * 2 + 1] = words[i]! & 0xff;
  }
  return out;
}

function inCidrV4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

function inCidrV6(ip: string, base: string, bits: number): boolean {
  const a = parseIpv6Bytes(ip);
  const b = parseIpv6Bytes(base);
  if (!a || !b) return false;
  let remaining = bits;
  for (let i = 0; i < 16; i++) {
    if (remaining <= 0) break;
    const take = Math.min(8, remaining);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((a[i]! & mask) !== (b[i]! & mask)) return false;
    remaining -= take;
  }
  return true;
}

/** Extract IPv4 from IPv4-mapped IPv6 (::ffff:a.b.c.d / ::ffff:aabb:ccdd). */
export function extractMappedIpv4(ip: string): string | null {
  const bytes = parseIpv6Bytes(ip);
  if (!bytes) return null;
  const mapped =
    bytes[0] === 0 &&
    bytes[1] === 0 &&
    bytes[2] === 0 &&
    bytes[3] === 0 &&
    bytes[4] === 0 &&
    bytes[5] === 0 &&
    bytes[6] === 0 &&
    bytes[7] === 0 &&
    bytes[8] === 0 &&
    bytes[9] === 0 &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  if (!mapped) return null;
  return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
}

/**
 * Canonicalize host IP literals including decimal/hex/octal single-number forms
 * and bracketed IPv6. Returns null if not an IP literal.
 */
export function canonicalizeIpLiteral(host: string): string | null {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);

  if (net.isIP(h) === 4) return h;
  if (net.isIP(h) === 6) {
    const mapped = extractMappedIpv4(h);
    return mapped ?? h;
  }

  // Single-number IPv4 tricks: 0x7f000001, 2130706433, 017700000001
  if (/^0x[0-9a-f]+$/i.test(h)) {
    const n = Number.parseInt(h, 16);
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) return intToIpv4(n);
  }
  if (/^0[0-7]+$/.test(h)) {
    const n = Number.parseInt(h, 8);
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) return intToIpv4(n);
  }
  if (/^\d+$/.test(h)) {
    const n = Number(h);
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) return intToIpv4(n);
  }

  // Dotted forms with hex/octal components: 0x7f.0.0.1, 0177.0.0.1
  if (h.includes(".") && !h.includes(":")) {
    const parts = h.split(".");
    if (parts.length === 4) {
      const nums: number[] = [];
      for (const p of parts) {
        let n: number;
        if (/^0x[0-9a-f]+$/i.test(p)) n = Number.parseInt(p, 16);
        else if (/^0[0-7]+$/.test(p)) n = Number.parseInt(p, 8);
        else if (/^\d+$/.test(p)) n = Number(p);
        else return null;
        if (!Number.isInteger(n) || n < 0 || n > 255) return null;
        nums.push(n);
      }
      return nums.join(".");
    }
  }

  // Try IPv6 parse even if net.isIP failed on unusual forms
  const bytes = parseIpv6Bytes(h);
  if (bytes) {
    const mapped = extractMappedIpv4(h);
    if (mapped) return mapped;
    // Reconstruct compressed form via net — join standard
    const words: string[] = [];
    for (let i = 0; i < 8; i++) {
      words.push(((bytes[i * 2]! << 8) | bytes[i * 2 + 1]!).toString(16));
    }
    const rebuilt = words.join(":");
    if (net.isIP(rebuilt) === 6) return rebuilt;
  }

  return null;
}

export function isDeniedAddress(ip: string): { denied: boolean; reason: string } {
  let addr = ip;
  const mapped = extractMappedIpv4(ip);
  if (mapped) addr = mapped;

  if (net.isIP(addr) === 4) {
    for (const r of V4_DENY) {
      if (inCidrV4(addr, r.base, r.bits)) {
        return { denied: true, reason: `denied-ip:${r.label}` };
      }
    }
    return { denied: false, reason: "ok" };
  }

  if (net.isIP(addr) === 6 || parseIpv6Bytes(addr)) {
    for (const r of V6_DENY) {
      if (inCidrV6(addr, r.base, r.bits)) {
        return { denied: true, reason: `denied-ip:${r.label}` };
      }
    }
    return { denied: false, reason: "ok" };
  }

  return { denied: true, reason: "denied-ip:unparseable" };
}

export function hostMatchesAllowlist(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  for (const entry of allowlist) {
    const e = entry.toLowerCase().replace(/\.$/, "");
    if (e.startsWith("*.")) {
      const suffix = e.slice(1); // .example.com
      if (h.endsWith(suffix) || h === e.slice(2)) return true;
    } else if (h === e) {
      return true;
    }
  }
  return false;
}

const defaultLookup: LookupFn = async (hostname) => {
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family }));
};

/** RFC 6761 special-use TLDs — deny without upstream lookup (DNS-label exfil). */
const RESERVED_TLDS = new Set(["invalid", "localhost", "example", "local"]);

function isReservedTld(host: string): boolean {
  const last = host.toLowerCase().replace(/\.$/, "").split(".").pop() ?? "";
  return RESERVED_TLDS.has(last);
}

/**
 * Cloud metadata hostnames/IPs — deny before DNS (OpenBot NEVER_ALLOWED_HOSTNAMES).
 * Additive to CIDR; names would otherwise depend on the sidecar resolver.
 */
const NEVER_ALLOWED_HOSTNAMES = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
  "fd00:ec2::254",
  "169.254.170.2",
  "100.100.100.200",
]);

function foldHostname(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/** True for metadata aliases and never-list IP literals (any IPv6 spelling). */
export function isNeverAllowedHostname(hostname: string): boolean {
  const h = foldHostname(hostname);
  if (NEVER_ALLOWED_HOSTNAMES.has(h)) return true;
  const lit = canonicalizeIpLiteral(h);
  if (!lit) return false;
  if (NEVER_ALLOWED_HOSTNAMES.has(lit)) return true;
  for (const n of NEVER_ALLOWED_HOSTNAMES) {
    const nlit = canonicalizeIpLiteral(n);
    if (nlit && nlit === lit) return true;
  }
  return false;
}

/**
 * Evaluate destination host:port. Resolves DNS with lookup({all:true}) and
 * denies if any address is private/link-local/loopback/metadata.
 * Call again immediately before connect to defeat DNS rebinding.
 */
export async function evaluateDestination(
  host: string,
  port: number,
  policy: PolicyConfig,
  lookup: LookupFn = defaultLookup,
): Promise<Decision> {
  const cleanHost = host.trim().toLowerCase().replace(/^\[|\]$/g, "");

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      allowed: false,
      reason: "denied-port:invalid",
      host: cleanHost,
      port,
      addresses: [],
    };
  }

  if (!policy.allowedPorts.includes(port)) {
    return {
      allowed: false,
      reason: `denied-port:${port}`,
      host: cleanHost,
      port,
      addresses: [],
    };
  }

  if (isNeverAllowedHostname(cleanHost)) {
    const lit = canonicalizeIpLiteral(foldHostname(cleanHost));
    return {
      allowed: false,
      reason: "denied-host:never",
      host: cleanHost,
      port,
      addresses: lit ? [lit] : [],
    };
  }

  if (policy.mode === "strict") {
    // Strict: an IP must appear in the allowlist as an exact string too.
    const literal = canonicalizeIpLiteral(cleanHost);
    if (
      !hostMatchesAllowlist(literal ?? cleanHost, policy.allowlist) &&
      !hostMatchesAllowlist(cleanHost, policy.allowlist)
    ) {
      return {
        allowed: false,
        reason: "denied-allowlist",
        host: cleanHost,
        port,
        addresses: [],
      };
    }
  }

  if (isReservedTld(cleanHost)) {
    return {
      allowed: false,
      reason: "denied-dns:reserved-tld",
      host: cleanHost,
      port,
      addresses: [],
    };
  }

  const literal = canonicalizeIpLiteral(cleanHost);
  if (literal) {
    const d = isDeniedAddress(literal);
    if (d.denied) {
      return {
        allowed: false,
        reason: d.reason,
        host: cleanHost,
        port,
        addresses: [literal],
      };
    }
    return {
      allowed: true,
      reason: "allowed",
      host: cleanHost,
      port,
      addresses: [literal],
    };
  }

  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(cleanHost);
  } catch {
    return {
      allowed: false,
      reason: "denied-dns:resolve-failed",
      host: cleanHost,
      port,
      addresses: [],
    };
  }

  if (addrs.length === 0) {
    return {
      allowed: false,
      reason: "denied-dns:empty",
      host: cleanHost,
      port,
      addresses: [],
    };
  }

  const addresses: string[] = [];
  for (const a of addrs) {
    const canon = canonicalizeIpLiteral(a.address) ?? a.address;
    addresses.push(canon);
    const d = isDeniedAddress(canon);
    if (d.denied) {
      return {
        allowed: false,
        reason: d.reason,
        host: cleanHost,
        port,
        addresses,
      };
    }
  }

  return {
    allowed: true,
    reason: "allowed",
    host: cleanHost,
    port,
    addresses,
  };
}

export function parseHostPort(
  authority: string,
  defaultPort: number,
): { host: string; port: number } | null {
  let s = authority.trim();
  if (!s) return null;
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end < 0) return null;
    const host = s.slice(1, end);
    const rest = s.slice(end + 1);
    if (rest === "") return { host, port: defaultPort };
    if (!rest.startsWith(":")) return null;
    const port = Number(rest.slice(1));
    if (!Number.isInteger(port)) return null;
    return { host, port };
  }
  const idx = s.lastIndexOf(":");
  if (idx > 0 && s.indexOf(":") === idx) {
    const host = s.slice(0, idx);
    const port = Number(s.slice(idx + 1));
    if (!Number.isInteger(port)) return null;
    return { host, port };
  }
  return { host: s, port: defaultPort };
}
