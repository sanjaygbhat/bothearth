/**
 * Sandbox-facing stub resolver. Never forwards / recurses (no node:dns).
 * NXDOMAIN every query so DNS-label exfil cannot leave the internal net.
 */
import dgram from "node:dgram";
import net from "node:net";
import type { AddressInfo } from "node:net";

const MAX_NAME_LOG = 64;

type DnsStats = {
  queries: number;
  forwarded: number;
  names: string[];
};

export type DnsSinkhole = {
  stats: () => DnsStats;
  close: () => Promise<void>;
  udpPort: () => number;
  tcpPort: () => number;
};

export function encodeQuery(name: string, id = 0x1234): Buffer {
  const labels = name.replace(/\.$/, "").split(".").filter(Boolean);
  const q = Buffer.alloc(12 + labels.reduce((n, l) => n + 1 + l.length, 0) + 1 + 4);
  q.writeUInt16BE(id & 0xffff, 0);
  q.writeUInt16BE(0x0100, 2); // RD
  q.writeUInt16BE(1, 4); // QDCOUNT
  let o = 12;
  for (const lab of labels) {
    if (lab.length > 63) throw new Error("label too long");
    q[o++] = lab.length;
    q.write(lab, o, "ascii");
    o += lab.length;
  }
  q[o++] = 0;
  q.writeUInt16BE(1, o); // A
  q.writeUInt16BE(1, o + 2); // IN
  return q;
}

export function parseQuestionName(msg: Buffer): string | null {
  if (msg.length < 12) return null;
  try {
    const { name } = readName(msg, 12, 0);
    return name.toLowerCase();
  } catch {
    return null;
  }
}

function readName(msg: Buffer, offset: number, depth: number): { name: string; offset: number } {
  if (depth > 10) throw new Error("ptr loop");
  const labels: string[] = [];
  let jumped = false;
  let end = offset;
  for (;;) {
    if (offset >= msg.length) throw new Error("truncated");
    const len = msg[offset]!;
    if (len === 0) {
      if (!jumped) end = offset + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (offset + 1 >= msg.length) throw new Error("truncated ptr");
      const ptr = ((len & 0x3f) << 8) | msg[offset + 1]!;
      if (!jumped) end = offset + 2;
      const inner = readName(msg, ptr, depth + 1);
      labels.push(...(inner.name ? inner.name.split(".") : []));
      jumped = true;
      break;
    }
    if ((len & 0xc0) !== 0) throw new Error("bad label");
    offset += 1;
    if (offset + len > msg.length) throw new Error("truncated label");
    labels.push(msg.subarray(offset, offset + len).toString("ascii"));
    offset += len;
    if (!jumped) end = offset;
  }
  return { name: labels.filter(Boolean).join("."), offset: end };
}

function questionEnd(msg: Buffer): number {
  const qd = msg.readUInt16BE(4);
  let o = 12;
  for (let i = 0; i < qd; i++) {
    const n = readName(msg, o, 0);
    o = n.offset + 4; // QTYPE QCLASS
  }
  return o;
}

/** QR=1, RA=0, RCODE=NXDOMAIN (3); copy questions; no answers; never recurse. */
export function nxdomainResponse(query: Buffer): Buffer | null {
  if (query.length < 12) return null;
  let qEnd: number;
  try {
    qEnd = questionEnd(query);
  } catch {
    qEnd = Math.min(query.length, 12);
  }
  const out = Buffer.from(query.subarray(0, qEnd));
  const rd = query[2]! & 0x01;
  const opcode = query[2]! & 0x78;
  out[2] = 0x80 | opcode | rd; // QR=1, AA=0, TC=0
  out[3] = (query[3]! & 0x70) | 0x03; // RA=0, RCODE=3
  out.writeUInt16BE(0, 6); // ANCOUNT
  out.writeUInt16BE(0, 8); // NSCOUNT
  out.writeUInt16BE(0, 10); // ARCOUNT
  return out;
}

export function createDnsSinkhole(): {
  record: (name: string | null) => void;
  stats: () => DnsStats;
  handleUdp: (msg: Buffer, rinfo: dgram.RemoteInfo, sock: dgram.Socket) => void;
  handleTcp: (socket: net.Socket) => void;
} {
  let queries = 0;
  const names: string[] = [];
  const seen = new Set<string>();

  const record = (name: string | null): void => {
    queries += 1;
    if (!name) return;
    if (seen.has(name)) return;
    seen.add(name);
    names.push(name);
    if (names.length > MAX_NAME_LOG) seen.delete(names.shift()!);
  };

  return {
    record,
    stats: () => ({ queries, forwarded: 0, names: [...names] }),
    handleUdp(msg, rinfo, sock) {
      const name = parseQuestionName(msg);
      record(name);
      const resp = nxdomainResponse(msg);
      if (resp) sock.send(resp, rinfo.port, rinfo.address);
    },
    handleTcp(socket) {
      const chunks: Buffer[] = [];
      let total = 0;
      const cap = 64 * 1024;
      socket.setTimeout(5_000, () => {
        socket.destroy();
      });
      socket.on("data", (c) => {
        total += c.length;
        if (total > cap) {
          socket.destroy();
          return;
        }
        chunks.push(c);
        const buf = Buffer.concat(chunks);
        if (buf.length < 2) return;
        const len = buf.readUInt16BE(0);
        if (2 + len > cap) {
          socket.destroy();
          return;
        }
        if (buf.length < 2 + len) return;
        const msg = buf.subarray(2, 2 + len);
        const name = parseQuestionName(msg);
        record(name);
        const resp = nxdomainResponse(msg);
        if (resp) {
          const framed = Buffer.alloc(2 + resp.length);
          framed.writeUInt16BE(resp.length, 0);
          resp.copy(framed, 2);
          socket.write(framed);
        }
        socket.end();
      });
      socket.on("error", () => {
        socket.destroy();
      });
    },
  };
}

export function startDnsSinkhole(
  port = 53,
  listenHost = "0.0.0.0",
): Promise<DnsSinkhole> {
  const core = createDnsSinkhole();
  const udp = dgram.createSocket("udp4");
  const tcp = net.createServer((s) => core.handleTcp(s));

  udp.on("message", (msg, rinfo) => core.handleUdp(msg, rinfo, udp));

  return new Promise((resolve, reject) => {
    const fail = (err: Error): void => {
      udp.close();
      tcp.close();
      reject(err);
    };
    udp.once("error", fail);
    tcp.once("error", fail);
    udp.bind(port, listenHost, () => {
      tcp.listen(port, listenHost, () => {
        udp.removeListener("error", fail);
        tcp.removeListener("error", fail);
        const close = async (): Promise<void> => {
          await Promise.all([
            new Promise<void>((res) => udp.close(() => res())),
            new Promise<void>((res, rej) => tcp.close((e) => (e ? rej(e) : res()))),
          ]);
        };
        resolve({
          stats: core.stats,
          close,
          udpPort: () => (udp.address() as AddressInfo).port,
          tcpPort: () => (tcp.address() as AddressInfo).port,
        });
      });
    });
  });
}
