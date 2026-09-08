import assert from "node:assert/strict";
import { test } from "node:test";
import { bootstrapSessionFromUrl } from "../../../src/ui/session.ts";
import { getCsrfToken, setCsrfToken } from "../../../src/ui/api.ts";
import { renewalReturnHash } from "../../../src/ui/session.ts";

function environment() {
  const saved = { location: globalThis.location, history: globalThis.history, fetch: globalThis.fetch };
  const csrf = getCsrfToken();
  globalThis.location = { href: "http://localhost/#bootstrap=synthetic-one" } as Location;
  globalThis.history = { replaceState(_a: unknown, _b: string, url: string) { location.href = new URL(url, location.href).href; } } as History;
  return () => { Object.assign(globalThis, saved); setCsrfToken(csrf); };
}

test("bootstrap links strip immediately, serialize cookie/CSRF exchanges and preserve newer navigation", async () => {
  const restore = environment();
  const first = Promise.withResolvers<Response>(); const calls: string[] = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(String(options?.body)).token);
    return calls.length === 1 ? first.promise : Response.json({ ok: true, csrf: "second-csrf" });
  };
  try {
    const one = bootstrapSessionFromUrl("#/tasks/original");
    assert.equal(location.href, "http://localhost/#/tasks/original", "token is removed before the network response");
    await new Promise(setImmediate);
    location.href = "http://localhost/#bootstrap=synthetic-two";
    const two = bootstrapSessionFromUrl("#/tasks/original");
    await new Promise(setImmediate); assert.equal(calls.length, 1, "a second response must not race the session cookie");
    location.href = "http://localhost/#/settings";
    first.resolve(Response.json({ ok: true, csrf: "first-csrf" })); await one; await two;
    assert.deepEqual(calls, ["synthetic-one", "synthetic-two"]);
    assert.equal(getCsrfToken(), "second-csrf"); assert.equal(location.href, "http://localhost/#/settings");
  } finally { restore(); }
});

test("a fresh startup link renews in place and keeps the screen you were on", () => {
  const here = "http://localhost/#bootstrap=fresh";
  assert.equal(renewalReturnHash("http://localhost/#/tasks/t_9", here, here), "#/tasks/t_9");
  assert.equal(renewalReturnHash("http://localhost/#/settings", here, here), "#/settings");
  assert.equal(
    renewalReturnHash("http://localhost/", here, here),
    "#/",
    "with no earlier route the app lands home, not on an empty hash",
  );
  assert.equal(
    renewalReturnHash("http://localhost/#/tasks/t_9", here, "http://localhost/#/settings"),
    null,
    "a superseded link is ignored rather than raced",
  );
  assert.equal(
    renewalReturnHash("http://localhost/#/", "http://localhost/#/tasks", "http://localhost/#/tasks"),
    null,
    "an ordinary navigation is not a renewal",
  );
});
