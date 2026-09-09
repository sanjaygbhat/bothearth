import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { grantedOriginsFor } from "../../../src/policy/approvals.ts";

describe("grantedOriginsFor: www sibling is public-suffix aware", () => {
  it("pairs www with the apex in both directions for a registrable domain", () => {
    assert.deepEqual(grantedOriginsFor("https://www.example.com/a"), [
      "https://www.example.com",
      "https://example.com",
    ]);
    assert.deepEqual(grantedOriginsFor("https://example.com/a"), [
      "https://example.com",
      "https://www.example.com",
    ]);
  });

  it("pairs www with a registrable domain under a multi-label public suffix", () => {
    assert.deepEqual(grantedOriginsFor("https://www.bbc.co.uk/"), [
      "https://www.bbc.co.uk",
      "https://bbc.co.uk",
    ]);
    assert.deepEqual(grantedOriginsFor("https://myapp.github.io/"), [
      "https://myapp.github.io",
      "https://www.myapp.github.io",
    ]);
  });

  it("never derives a sibling across a public suffix", () => {
    // www.<suffix> must not grant the suffix itself: different owners.
    for (const host of [
      "www.github.io",
      "www.co.uk",
      "www.vercel.app",
      "www.pages.dev",
      "www.s3.amazonaws.com",
      "www.glitch.me",
      "www.co.il",
      "www.com.sg",
      "www.appspot.com",
    ]) {
      assert.deepEqual(
        grantedOriginsFor(`https://${host}/`),
        [`https://${host}`],
        `${host} must grant only itself`,
      );
    }
    // ...and the suffix itself must not grant its www form either.
    assert.deepEqual(grantedOriginsFor("https://github.io/"), ["https://github.io"]);
    assert.deepEqual(grantedOriginsFor("https://co.uk/"), ["https://co.uk"]);
  });

  it("never derives a sibling from a single label", () => {
    assert.deepEqual(grantedOriginsFor("http://localhost:3000/"), ["http://localhost:3000"]);
    assert.deepEqual(grantedOriginsFor("http://www.localhost/"), ["http://www.localhost"]);
  });

  it("grants exact origins only — no subdomain widening, no lookalike", () => {
    const granted = grantedOriginsFor("https://example.com/");
    for (const other of [
      "https://evil-example.com",
      "https://example.com.evil.test",
      "https://mail.example.com",
      "https://www.www.example.com",
    ]) {
      assert.ok(!granted.includes(other), `${other} must not be granted`);
    }
    // A subdomain grant stays on that subdomain and its own www alias.
    assert.deepEqual(grantedOriginsFor("https://mail.example.com/"), [
      "https://mail.example.com",
      "https://www.mail.example.com",
    ]);
  });

  it("respects scheme and port on both halves of the pair", () => {
    assert.deepEqual(grantedOriginsFor("http://example.com:8080/x"), [
      "http://example.com:8080",
      "http://www.example.com:8080",
    ]);
    const https = grantedOriginsFor("https://example.com/");
    assert.ok(!https.includes("http://example.com"), "scheme must not be widened");
    const plain = grantedOriginsFor("http://www.example.com/");
    assert.deepEqual(plain, ["http://www.example.com", "http://example.com"]);
    assert.ok(!plain.some((o) => o.startsWith("https:")));
    // A port on one origin never grants the default-port origin.
    assert.ok(!grantedOriginsFor("http://example.com:8080/").includes("http://example.com"));
  });

  it("still refuses IP literals and non-http schemes", () => {
    assert.deepEqual(grantedOriginsFor("https://127.0.0.1:9000/"), ["https://127.0.0.1:9000"]);
    assert.deepEqual(grantedOriginsFor("http://[::1]:8080/"), ["http://[::1]:8080"]);
    assert.deepEqual(grantedOriginsFor("file:///etc/passwd"), []);
    assert.deepEqual(grantedOriginsFor("not a url"), []);
  });
});
