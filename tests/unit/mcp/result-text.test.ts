import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assembleConnectorCallContent,
  DEFAULT_MAX_RESULT_CHARS,
  resultText,
  sanitizeConnectorResult,
} from "../../../src/mcp/client.ts";

describe("MCP resultText + truncate count", () => {
  it("empty MCP content result string contains Nothing was found", () => {
    const empty = resultText([]);
    assert.match(empty.text, /Nothing was found/);
    assert.equal(empty.truncated, false);
    const whitespace = resultText([{ type: "text", text: "  \n" }]);
    assert.match(whitespace.text, /Nothing was found/);
  });

  it("truncated result suffix contains the original character count", () => {
    const original = "x".repeat(100);
    const { text, truncated } = resultText([{ type: "text", text: original }], 40);
    assert.equal(truncated, true);
    assert.match(text, /100/);
    assert.match(text, /truncated/);

    const scrub = sanitizeConnectorResult(original, { maxChars: 40 });
    assert.equal(scrub.truncated, true);
    assert.match(String(scrub.value), /100/);
    assert.match(String(scrub.value), /truncated/);
  });

  it("image part becomes [image N KB] placeholder in resultText", () => {
    const data = "iVBORw0KGgo";
    const { text } = resultText([
      { type: "image", mimeType: "image/png", data },
    ]);
    assert.match(text, /^\[image 0\.0 KB\]$/);
    assert.equal(text.includes(data), false);
  });

  it("1 MB image part: content bytes ≤ maxResultChars and base64 at most once", () => {
    const data = "A".repeat(1024 * 1024);
    const { content, truncated } = assembleConnectorCallContent(
      [{ type: "image", mimeType: "image/png", data }],
      { maxChars: DEFAULT_MAX_RESULT_CHARS },
    );
    const encoded = JSON.stringify(content);
    assert.ok(
      Buffer.byteLength(encoded, "utf8") <= DEFAULT_MAX_RESULT_CHARS,
    );
    assert.ok((encoded.split(data).length - 1) <= 1);
    assert.match(encoded, /\[image 1024\.0 KB\]/);
    assert.equal(truncated, true);
    assert.match(encoded, /dropped 1 non-text part\(s\)/);
  });
});
