import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdapterMessage, AdapterToolCall } from "../../../src/types/contracts.ts";
import {
  compactTokenThreshold,
  compactTranscript,
  inputTokensExceedCompactAt,
} from "../../../src/daemon/compact.ts";

describe("compactTranscript", () => {
  it("keeps last 3 tool observations and one assistant truncation note", () => {
    const messages: AdapterMessage[] = [];
    for (let i = 1; i <= 4; i += 1) {
      messages.push({ role: "user", content: `obs${i}` });
      messages.push({
        role: "assistant",
        content: `a${i}`,
        tool_calls: [{ id: `t${i}`, name: "browser_wait", arguments: {} }],
      } as AdapterMessage & { tool_calls: AdapterToolCall[] });
      messages.push({ role: "tool", tool_call_id: `t${i}`, name: "browser_wait", content: `r${i}` });
    }
    const result = compactTranscript(messages, 3);
    assert.equal(result.compacted, true);
    assert.equal(result.removed, 4);
    assert.equal(messages[0]!.role, "assistant");
    assert.match(String(messages[0]!.content), /deterministic truncation/);
    assert.deepEqual(
      messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
      ["t2", "t3", "t4"],
    );
    assert.ok(!messages.some((m) => m.role === "user" && m.content === "obs1"));
  });

  it("keeps the assistant declaration for every retained tool result", () => {
    const messages: Array<AdapterMessage & { tool_calls?: AdapterToolCall[] }> = [];
    for (let i = 1; i <= 4; i += 1) {
      messages.push({ role: "user", content: `obs${i}` });
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: [{ id: `t${i}`, name: "browser_wait", arguments: {} }],
      });
      messages.push({ role: "tool", tool_call_id: `t${i}`, name: "browser_wait", content: `r${i}` });
    }

    compactTranscript(messages, 3);

    const declared = new Set(
      messages.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []),
    );
    for (const message of messages) {
      if (message.role === "tool") assert.ok(declared.has(message.tool_call_id!));
    }
  });

  it("is a no-op when there is nothing older than the kept tail", () => {
    const messages: AdapterMessage[] = [
      { role: "tool", tool_call_id: "t1", name: "browser_wait", content: "r1" },
    ];
    const result = compactTranscript(messages, 3);
    assert.equal(result.compacted, false);
    assert.equal(messages.length, 1);
  });
});

describe("compact_at threshold", () => {
  it("fires strictly above compact_at * context_tokens_max", () => {
    assert.equal(compactTokenThreshold(100, 0.5), 50);
    assert.equal(inputTokensExceedCompactAt(50, 100, 0.5), false);
    assert.equal(inputTokensExceedCompactAt(51, 100, 0.5), true);
    assert.equal(inputTokensExceedCompactAt(80, 100, 0), false);
  });
});
