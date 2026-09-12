import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
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
import {
  createWebhookSender,
  hmacWebhookSignature,
  verifyWebhook,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "../../../src/notify/sender.ts";

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
      `telegram:123456:synthetic-token:chat99`,
    ],
    async (input, init) => {
      // Rewrite telegram API host to local mock
      const u = String(input);
      assert.ok(init?.signal instanceof AbortSignal, "every channel has a bounded request");
      if (u.includes("api.telegram.org")) {
        assert.ok(u.endsWith("/bot123456:synthetic-token/sendMessage"));
        assert.equal(JSON.parse(String(init?.body)).chat_id, "chat99");
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

test("webhook test-ping has signature, timestamp, and event id", async () => {
  const secret = "unit-webhook-secret";
  let captured: { headers: Record<string, string>; body: string } | undefined;
  const sender = createWebhookSender(
    "https://example.test/hook",
    async (_input, init) => {
      captured = {
        headers: { ...(init?.headers as Record<string, string>) },
        body: String(init?.body),
      };
      return new Response("ok", { status: 200 });
    },
    { secret },
  );

  await sender.send({
    kind: "task_done",
    title: "test-ping",
    reason: "ok at https://evil.test/x",
  });

  assert.ok(captured);
  const signature = captured.headers[WEBHOOK_SIGNATURE_HEADER];
  const timestamp = captured.headers[WEBHOOK_TIMESTAMP_HEADER];
  const eventId = captured.headers[WEBHOOK_EVENT_ID_HEADER];
  assert.ok(signature?.startsWith("hmac-sha256:"));
  assert.match(timestamp ?? "", /^\d+$/);
  assert.ok(eventId);
  assert.equal(JSON.parse(captured.body).event_id, eventId);
  assert.equal(captured.body.includes("https://evil.test"), false);
  const independent = createHmac("sha256", secret)
    .update(`${timestamp}.${eventId}.${captured.body}`)
    .digest("hex");
  assert.equal(signature.slice("hmac-sha256:".length), independent);
  assert.equal(
    verifyWebhook({
      secret,
      signature,
      timestamp,
      eventId,
      body: captured.body,
    }),
    true,
  );
});

test("webhook verify rejects a body older than 5 minutes", () => {
  const secret = "unit-webhook-secret";
  const body = '{"kind":"task_done","event_id":"evt-old"}';
  const eventId = "evt-old";
  const nowMs = 1_800_000_000_000;
  const timestamp = String(Math.floor(nowMs / 1000) - 5 * 60 - 1);
  const signature = hmacWebhookSignature(secret, timestamp, eventId, body);
  assert.equal(verifyWebhook({ secret, signature, timestamp, eventId, body, nowMs }), false);
  const freshTs = String(Math.floor(nowMs / 1000));
  const freshSig = hmacWebhookSignature(secret, freshTs, eventId, body);
  assert.equal(
    verifyWebhook({
      secret,
      signature: freshSig,
      timestamp: freshTs,
      eventId,
      body,
      nowMs,
    }),
    true,
  );
});

test("verifyWebhook rejects a wrong secret, mutated body, and swapped event id", () => {
  const secret = "unit-webhook-secret";
  const body = '{"kind":"task_done","event_id":"evt-mac"}';
  const eventId = "evt-mac";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = hmacWebhookSignature(secret, timestamp, eventId, body);
  const independent = createHmac("sha256", secret)
    .update(`${timestamp}.${eventId}.${body}`)
    .digest("hex");
  assert.equal(signature.slice("hmac-sha256:".length), independent);
  assert.equal(
    verifyWebhook({ secret: "wrong-secret", signature, timestamp, eventId, body }),
    false,
  );
  assert.equal(verifyWebhook({ secret, signature, timestamp, eventId, body: `${body}x` }), false);
  assert.equal(verifyWebhook({ secret, signature, timestamp, eventId: "evt-other", body }), false);
});

test("empty webhook secret omits signature headers and does not verify", async () => {
  const prev = process.env.MODELBOT_WEBHOOK_SECRET;
  delete process.env.MODELBOT_WEBHOOK_SECRET;
  try {
    let captured: { headers: Record<string, string> } | undefined;
    const sender = createWebhookSender("https://example.test/hook", async (_input, init) => {
      captured = {
        headers: { ...(init?.headers as Record<string, string>) },
      };
      return new Response("ok", { status: 200 });
    });
    await sender.send({ kind: "task_done", title: "test-ping" });
    assert.ok(captured);
    assert.equal(captured.headers[WEBHOOK_SIGNATURE_HEADER], undefined);
    assert.equal(captured.headers[WEBHOOK_TIMESTAMP_HEADER], undefined);
    assert.equal(captured.headers[WEBHOOK_EVENT_ID_HEADER], undefined);

    const body = '{"kind":"task_done","event_id":"evt-empty"}';
    const eventId = "evt-empty";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const emptyKeySig = hmacWebhookSignature("", timestamp, eventId, body);
    assert.equal(
      verifyWebhook({
        secret: "",
        signature: emptyKeySig,
        timestamp,
        eventId,
        body,
      }),
      false,
    );
  } finally {
    if (prev === undefined) delete process.env.MODELBOT_WEBHOOK_SECRET;
    else process.env.MODELBOT_WEBHOOK_SECRET = prev;
  }
});
