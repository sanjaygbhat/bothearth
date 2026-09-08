import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactLogFields } from "../../../src/daemon/log.ts";

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

describe("daemon log redactor", () => {
  it("redacts secret keys after suffix and case/separator normalisation", () => {
    const out = redactLogFields({
      password_preview: "hunter2",
      "Authorization-Preview": "Bearer abc",
      apiKeyPreview: "sk-live-secret",
    }) as Record<string, unknown>;
    assert.equal(out.password_preview, "[redacted]");
    assert.equal(out["Authorization-Preview"], "[redacted]");
    assert.equal(out.apiKeyPreview, "[redacted]");
  });

  it("redacts a JWT inside an ordinary note field", () => {
    const out = redactLogFields({
      note: `user session ${JWT} ok`,
    }) as Record<string, unknown>;
    assert.equal(out.note, "user session [redacted] ok");
    assert.equal(String(out.note).includes("eyJ"), false);
  });

  it("leaves ordinary text untouched", () => {
    const out = redactLogFields({
      msg: "clicked Continue",
      count: 3,
    }) as Record<string, unknown>;
    assert.equal(out.msg, "clicked Continue");
    assert.equal(out.count, 3);
  });
});
