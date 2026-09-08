import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  appendCapped,
  createAccessLogger,
  formatAccessLine,
  isVerboseAccessLog,
} from "../../../src/proxy/access-log.ts";

const sample = {
  ts: "2026-09-03T00:00:00.000Z",
  host: "example.com",
  port: 443,
  allowed: true,
  reason: "allowed",
  bytes: 42,
  method: "GET",
  path: "/secret/page",
};

describe("proxy access log", () => {
  it("default line is host:port + decision + bytes; no method/path/query", () => {
    const text = formatAccessLine(sample, false);
    const rec = JSON.parse(text) as Record<string, unknown>;
    assert.equal(rec.host, "example.com");
    assert.equal(rec.port, 443);
    assert.equal(rec.allowed, true);
    assert.equal(rec.reason, "allowed");
    assert.equal(rec.bytes, 42);
    assert.equal("method" in rec, false);
    assert.equal("path" in rec, false);
    assert.equal(text.includes("/secret"), false);
    assert.equal(text.includes("?"), false);
    assert.equal(text.includes("token="), false);
  });

  it("verbose adds method + pathname, still no query", () => {
    const text = formatAccessLine(
      { ...sample, path: "/login", method: "CONNECT" },
      true,
    );
    const rec = JSON.parse(text) as Record<string, unknown>;
    assert.equal(rec.method, "CONNECT");
    assert.equal(rec.path, "/login");
    assert.equal(text.includes("?token="), false);
  });

  it("PROXY_ACCESS_LOG_VERBOSE is off unless 1/true/yes", () => {
    assert.equal(isVerboseAccessLog({}), false);
    assert.equal(isVerboseAccessLog({ PROXY_ACCESS_LOG_VERBOSE: "0" }), false);
    assert.equal(isVerboseAccessLog({ PROXY_ACCESS_LOG_VERBOSE: "1" }), true);
  });

  it("size-capped ring rotates so the live file cannot grow unbounded", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-proxy-log-"));
    const path = join(dir, "proxy-access.jsonl");
    const max = 80;
    for (let i = 0; i < 20; i++) {
      appendCapped(path, `{"n":${i}}\n`, max);
    }
    assert.ok(statSync(path).size <= max);
    assert.ok(existsSync(`${path}.1`));
    assert.ok(statSync(`${path}.1`).size <= max + 20);
  });

  it("logger writes stdout + capped file; default env is not verbose", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-proxy-log-"));
    const path = join(dir, "access.jsonl");
    const chunks: string[] = [];
    const log = createAccessLogger(
      {
        PROXY_ACCESS_LOG_VERBOSE: "0",
        PROXY_ACCESS_LOG_PATH: path,
        PROXY_ACCESS_LOG_MAX_BYTES: "4096",
      },
      { write: (s) => chunks.push(s) },
    );
    log.write({ ...sample, path: "/q?token=abc" });
    const out = chunks.join("");
    assert.equal(out.includes("/q"), false);
    assert.equal(out.includes("token="), false);
    const file = readFileSync(path, "utf8");
    assert.equal(file.includes("token="), false);
    assert.match(file, /"host":"example.com"/);
  });
});
