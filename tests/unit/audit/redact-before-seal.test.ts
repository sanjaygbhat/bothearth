import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { AuditLog, readAuditRecords } from "../../../src/audit/log.ts";
import { staticAuditKey } from "../../../src/audit/key.ts";
import { verifyAuditFile } from "../../../src/audit/verify.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../../../src/cli/index.ts");

describe("audit redact-before-seal", () => {
  it("password/api_key/authorization become [REDACTED]; result/content/arguments survive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-audit-redact-"));
    const path = join(dir, "audit.jsonl");
    const key = Buffer.from("redact-before-seal-key-32b!!");
    const log = new AuditLog({
      path,
      keyProvider: staticAuditKey(key),
      anchorEvery: 100,
    });
    const result = { ok: true, stdout: "clicked" };
    const content = "tool output stays";
    const args = { selector: "#login" };
    const sealed = await log.append({
      type: "tool.call",
      task_id: "t1",
      body: {
        password: "hunter2",
        api_key: "sk-live-secret",
        authorization: "Bearer abc",
        cookie: "sid=1",
        token: "tkn",
        secret: "shh",
        password_preview: "still-secret",
        result,
        content,
        arguments: args,
      },
    });
    assert.equal(sealed.body.password, "[REDACTED]");
    assert.equal(sealed.body.api_key, "[REDACTED]");
    assert.equal(sealed.body.authorization, "[REDACTED]");
    assert.equal(sealed.body.cookie, "[REDACTED]");
    assert.equal(sealed.body.token, "[REDACTED]");
    assert.equal(sealed.body.secret, "[REDACTED]");
    assert.equal(sealed.body.password_preview, "[REDACTED]");
    assert.deepEqual(sealed.body.result, result);
    assert.equal(sealed.body.content, content);
    assert.deepEqual(sealed.body.arguments, args);
    assert.equal("result" in sealed.body, true);
    assert.equal("arguments" in sealed.body, true);

    const v = verifyAuditFile(key, path);
    assert.deepEqual(v, { ok: true, records: 1 });

    const keyPath = join(dir, "audit.key");
    writeFileSync(keyPath, key, { mode: 0o600 });
    const cliOk = spawnSync(
      process.execPath,
      ["--experimental-strip-types", cli, "audit", "verify", "--path", path, "--key-file", keyPath],
      { encoding: "utf8", env: { ...process.env } },
    );
    assert.equal(cliOk.status, 0, cliOk.stderr);
  });

  it("nested password under result is redacted; sibling password redacted; result key kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-audit-redact2-"));
    const path = join(dir, "audit.jsonl");
    const key = Buffer.from("redact-nested-key");
    const log = new AuditLog({
      path,
      keyProvider: staticAuditKey(key),
      anchorEvery: 100,
    });
    const rec = await log.append({
      type: "tool.call",
      body: { password: "hide-me", result: { password: "visible-for-forensics", ok: true } },
    });
    assert.equal(rec.body.password, "[REDACTED]");
    assert.deepEqual(rec.body.result, { password: "[REDACTED]", ok: true });
    assert.equal(verifyAuditFile(key, path).ok, true);
    assert.equal(readAuditRecords(path)[0]!.body.password, "[REDACTED]");
  });

  it("nested arguments.password CANARY is sealed as [REDACTED]; arguments.text survives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-audit-redact3-"));
    const path = join(dir, "audit.jsonl");
    const key = Buffer.from("redact-canary-key-32bytes!!!!");
    const log = new AuditLog({
      path,
      keyProvider: staticAuditKey(key),
      anchorEvery: 100,
    });
    const sealed = await log.append({
      type: "tool.call",
      body: {
        arguments: { password: "CANARY", text: "keep" },
        result: { authorization: "Bearer abc123", cookie: "session=zzz", ok: true },
      },
    });
    const line = JSON.stringify(sealed);
    assert.equal(line.includes("CANARY"), false);
    assert.deepEqual(sealed.body.arguments, { password: "[REDACTED]", text: "keep" });
    const result = sealed.body.result as Record<string, unknown>;
    assert.equal(result.authorization, "[REDACTED]");
    assert.equal(result.cookie, "[REDACTED]");
    assert.equal(result.ok, true);
    assert.equal(verifyAuditFile(key, path).ok, true);
  });

  it("value-pattern sk-live-CANARY in arguments.text is redacted; key kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-audit-redact4-"));
    const path = join(dir, "audit.jsonl");
    const key = Buffer.from("redact-value-pattern-key-32b!!");
    const log = new AuditLog({
      path,
      keyProvider: staticAuditKey(key),
      anchorEvery: 100,
    });
    const sealed = await log.append({
      type: "tool.call",
      body: { arguments: { text: "sk-live-CANARY" } },
    });
    const line = JSON.stringify(sealed);
    assert.equal(line.includes("CANARY"), false);
    const args = sealed.body.arguments as Record<string, unknown>;
    assert.equal("text" in args, true);
    assert.equal(typeof args.text, "string");
    assert.equal(String(args.text).includes("CANARY"), false);
    assert.equal(verifyAuditFile(key, path).ok, true);
  });
});
