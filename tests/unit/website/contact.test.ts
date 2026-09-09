import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createContactServer } from "../../../enterprise/contact.mjs";

test("public contact delivers privately, validates submissions, and reports delivery failures", async () => {
  const mails: any[] = []; let fail = false; let time = Date.now();
  const server = createContactServer({ contact: "hidden-owner@example.org", from: "BotHearth <contact@bothearth.com>", now: () => time,
    sendMail: async (payload: any) => { if (fail) throw Error("provider error with hidden-owner@example.org"); mails.push(payload); } });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = async (overrides = {}, origin = "https://bothearth.com") => {
    const result = await fetch(`${base}/enquiry`, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ name: "Buyer", email: "buyer@example.com", organisation: "Example", seats: "2", message: "Two licences, billing in Canada.", ...overrides }) });
    const text = await result.text(); assert(!text.includes("hidden-owner@example.org")); assert(!text.includes("mailto:"));
    return { status: result.status, text };
  };
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await post({}, "https://evil.example")).status, 403);
    assert.equal((await post({ email: "a@b.com\r\nBcc:x@y.com" })).status, 400);
    assert.equal((await post({ seats: "-1" })).status, 400);
    assert.equal((await post({ website: "spam" })).status, 400);
    assert.equal((await post({ message: "x".repeat(17000) })).status, 413);
    const sent = await post(); assert.equal(sent.status, 200); assert.match(sent.text, /Enquiry sent/);
    assert.deepEqual(mails[0].to, ["hidden-owner@example.org"]);
    assert.equal(mails[0].reply_to, "buyer@example.com");
    assert.match(mails[0].text, /Two licences, billing in Canada/);
    assert.equal((await post()).status, 429); assert.equal(mails.length, 1);
    time += 61000; fail = true;
    const failed = await post(); assert.equal(failed.status, 503); assert.match(failed.text, /could not be sent/);
    time += 61000; fail = false; assert.equal((await post()).status, 200);
  } finally { server.close(); await once(server, "close"); }
});
