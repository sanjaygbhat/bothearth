import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { NATIVE_AFTER_HOLD_PROMPT, nativeTaskPrompt } from "../../../src/daemon/codex-runner.ts";

const CREDENTIALS_RULE = "Never ask for credentials in chat or expose them through model tools.";

const FORBIDDEN = [
  "explain the exact step",
  "request control if",
  "Use human control for private input",
  "Call request_takeover for passwords",
  "never ask for control again",
  "do not ask for control again",
  "it is not a reason to ask for control",
  "explain what is needed",
  "clearly state what is needed",
  "Never wait for a screen the page does not show",
  "2-step verification, a consent screen",
];

const task = { id: "task_1", computer_id: "comp_1", goal: "Open a page" };

function assertNeutral(text: string, label: string): void {
  for (const phrase of FORBIDDEN) {
    assert.equal(text.includes(phrase), false, `${label} still contains ${JSON.stringify(phrase)}`);
  }
}

function sourceFile(rel: string): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), rel), "utf8");
}

function systemPromptSource(): string {
  const src = sourceFile("../../../src/daemon/agent-loop.ts");
  const start = src.indexOf("function systemPrompt(");
  const end = src.indexOf("\nfunction driverTools(");
  assert.ok(start >= 0 && end > start, "systemPrompt block missing");
  return src.slice(start, end);
}

function nativePromptLiterals(): string {
  const src = sourceFile("../../../src/daemon/codex-runner.ts");
  const start = src.indexOf("export function nativeTaskPrompt(");
  const end = src.indexOf("export async function runCodexTask(");
  assert.ok(start >= 0 && end > start, "nativeTaskPrompt block missing");
  assert.match(src, /let prompt = nativeTaskPrompt\(task, inComputer, threadId\);/);
  assert.match(src, /prompt = NATIVE_AFTER_HOLD_PROMPT;/);
  return src.slice(start, end);
}

describe("native Codex prompt composition", () => {
  it("first-turn and resume omit when-to-ask coaching and keep wait/resume", () => {
    const firstHost = nativeTaskPrompt(task, false);
    const firstGuest = nativeTaskPrompt(task, true);
    const resume = nativeTaskPrompt(task, false, "thread-1");
    const literals = nativePromptLiterals();
    assert.equal(
      firstHost.includes(CREDENTIALS_RULE),
      true,
      "first-turn host missing credentials rule",
    );
    assert.equal(
      firstGuest.includes(CREDENTIALS_RULE),
      true,
      "first-turn guest missing credentials rule",
    );
    assert.equal(
      literals.includes(CREDENTIALS_RULE),
      true,
      "nativeTaskPrompt source missing credentials rule",
    );
    assertNeutral(firstHost, "first-turn host");
    assertNeutral(firstGuest, "first-turn guest");
    assertNeutral(resume, "resume");
    assertNeutral(NATIVE_AFTER_HOLD_PROMPT, "after hold");
    assertNeutral(literals, "codex-runner prompt literals");
    assert.match(
      firstHost,
      /If human control or approval is pending, stop browser actions and wait; this application resumes you after the operator responds\./,
    );
    assert.match(firstHost, /Do not call done while human control or approval is pending\./);
    assert.match(resume, /If human control or approval is pending, end your turn to wait\./);
    assert.match(NATIVE_AFTER_HOLD_PROMPT, /Call BotHearth takeover_status, then browser_snapshot/);
  });

  it("API-adapter systemPrompt drops when-to-ask lines only", () => {
    const prompt = systemPromptSource();
    assertNeutral(prompt, "agent-loop systemPrompt");
    assert.match(prompt, /After E_STALE_REF discard old refs and re-snapshot/);
    assert.match(prompt, /Call done exactly once when the goal is complete/);
  });
});
