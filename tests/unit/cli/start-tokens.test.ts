import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  hashBootstrapToken,
  mintStartBootstrapToken,
  readTokensFile,
  resolveRuntimeTokens,
  writeTokensFile,
} from "../../../src/cli/tokens.ts";

describe("runtime tokens on start", () => {
  it("refuses missing tokens with run modelbot init first", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-tok-"));
    assert.throws(
      () => resolveRuntimeTokens(join(dir, "tokens.json")),
      /run modelbot init first/,
    );
  });

  it("resolves persisted MCP token without requiring bootstrap plaintext", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-tok2-"));
    const path = join(dir, "tokens.json");
    mkdirSync(dir, { recursive: true });
    writeTokensFile(path, { mcp_token: "mcp-persisted-token-value-xx" });
    const prevM = process.env.MODELBOT_MCP_TOKEN;
    const prevB = process.env.MODELBOT_BOOTSTRAP_TOKEN;
    delete process.env.MODELBOT_MCP_TOKEN;
    delete process.env.MODELBOT_TOKEN;
    delete process.env.MODELBOT_BOOTSTRAP_TOKEN;
    try {
      const t = resolveRuntimeTokens(path);
      assert.equal(t.mcp_token, "mcp-persisted-token-value-xx");
    } finally {
      if (prevM === undefined) delete process.env.MODELBOT_MCP_TOKEN;
      else process.env.MODELBOT_MCP_TOKEN = prevM;
      if (prevB === undefined) delete process.env.MODELBOT_BOOTSTRAP_TOKEN;
      else process.env.MODELBOT_BOOTSTRAP_TOKEN = prevB;
    }
  });
});

describe("bootstrap token minting", () => {
  it("persisted file contains no plaintext token", () => {
    const dir = mkdtempSync(join(tmpdir(), "mb-boot-"));
    const path = join(dir, "tokens.json");
    writeTokensFile(path, {
      mcp_token: "mcp-persisted-token-value-xx",
      bootstrap_token: "boot-init-plaintext-should-be-stripped",
    });
    const token = mintStartBootstrapToken("mcp-persisted-token-value-xx", [path]);
    const raw = readFileSync(path, "utf8");
    assert.equal(raw.includes(token), false);
    assert.equal(raw.includes("boot-init-plaintext-should-be-stripped"), false);
    const parsed = JSON.parse(raw) as {
      mcp_token: string;
      bootstrap_token?: string;
      bootstrap_token_hash?: string;
    };
    assert.equal(parsed.bootstrap_token, undefined);
    assert.equal(parsed.bootstrap_token_hash, hashBootstrapToken(token));
    assert.equal(
      parsed.bootstrap_token_hash,
      createHash("sha256").update(token).digest("hex"),
    );
    const roundTrip = readTokensFile(path);
    assert.equal(roundTrip?.bootstrap_token, undefined);
    assert.equal(roundTrip?.bootstrap_token_hash, parsed.bootstrap_token_hash);
  });
});
