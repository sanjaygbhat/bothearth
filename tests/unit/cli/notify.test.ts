import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { test } from "node:test";
import {
  createNotifyFanout,
  stripUrlsFromModelReason,
} from "../../../src/notify/index.ts";

test("strips URLs from model reason", () => {
  const out = stripUrlsFromModelReason(
    "re-login at https://evil.example/phish now www.bad.test/x",
  );
  assert.equal(out.includes("https://"), false);
  assert.equal(out.includes("www.bad"), false);
  assert.match(out, /url removed/);
});

test("senders hit local mock HTTP server", async () => {
  const hits: { url: string; body: string; title?: string }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      hits.push({
        url: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
        title: req.headers.title as string | undefined,
      });
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;

  const fanout = createNotifyFanout(
    [
      `ntfy://${base}/topic-a`,
      `webhook:${base}/hook`,
      `telegram:tok123:chat99`,
    ],
    async (input, init) => {
      // Rewrite telegram API host to local mock
      const u = String(input);
      if (u.includes("api.telegram.org")) {
        return fetch(`${base}/telegram`, init);
      }
      return fetch(input, init);
    },
  );

  await fanout.send({
    kind: "takeover",
    title: "Need you",
    reason: "password at https://evil.test/login",
    url: "http://127.0.0.1:7777/takeover/1",
  });

  server.close();
  assert.ok(hits.length >= 3);
  const joined = hits.map((h) => h.body).join("\n");
  assert.equal(joined.includes("https://evil.test"), false);
  assert.ok(joined.includes("127.0.0.1:7777/takeover"));
});
