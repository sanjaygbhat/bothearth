import assert from "node:assert/strict";
import net from "node:net";
import { describe, it } from "node:test";
import { startDnsSinkhole } from "../../../src/proxy/dns.ts";

describe("DNS TCP sinkhole", () => {
  it("destroys a 1 MiB TCP payload with declared length 0xFFFF", async () => {
    const server = await startDnsSinkhole(0, "127.0.0.1");
    try {
      const port = server.tcpPort();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("socket not destroyed")), 4000);
        const s = net.connect({ host: "127.0.0.1", port }, () => {
          const header = Buffer.alloc(2);
          header.writeUInt16BE(0xffff, 0);
          s.write(header);
          s.write(Buffer.alloc(1024 * 1024));
        });
        s.on("close", () => {
          clearTimeout(timer);
          resolve();
        });
        s.on("error", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      await server.close();
    }
    assert.ok(true);
  });
});
