import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  evidenceSummary,
  expectOutcome,
  loadGoldenSuite,
  materializeArtifacts,
  renderPrompt,
  REQUIRED_TASK_IDS,
  scoreGoldenRow,
  taskLimits,
  type GoldenTask,
} from "./suite.ts";

function taskById(id: string): GoldenTask {
  const task = loadGoldenSuite().tasks.find((t) => t.id === id);
  assert.ok(task, id);
  return task;
}

describe("golden suite", () => {
  it("ships exactly the 12 required task ids", () => {
    const suite = loadGoldenSuite();
    assert.equal(suite.version, 1);
    assert.equal(suite.tasks.length, 12);
    assert.deepEqual(
      suite.tasks.map((t) => t.id).sort(),
      [...REQUIRED_TASK_IDS].sort(),
    );
    for (const task of suite.tasks) {
      assert.ok(task.expect.min_tool_calls >= 1, task.id);
    }
  });

  it("covers expect classes complete / takeover / spend_cap", () => {
    const suite = loadGoldenSuite();
    const outcomes = new Set(suite.tasks.map((t) => expectOutcome(t)));
    assert.ok(outcomes.has("complete"));
    assert.ok(outcomes.has("takeover"));
    assert.ok(outcomes.has("spend_cap"));
    const takeover = suite.tasks.filter((t) => expectOutcome(t) === "takeover");
    assert.equal(takeover.length, 1);
    assert.equal(takeover[0]!.id, "recaptcha-takeover");
    assert.equal(takeover[0]!.expect.event, "takeover_request");
    const spend = suite.tasks.filter((t) => expectOutcome(t) === "spend_cap");
    assert.equal(spend.length, 1);
    assert.ok((spend[0]!.spend_cap_usd ?? 0) < suite.defaults.spend_cap_usd);
    assert.equal(spend[0]!.expect.event, "spend_cap");
  });

  it("renders harness-neutral prompt with substituted fields", () => {
    const suite = loadGoldenSuite();
    const task = suite.tasks[0]!;
    const prompt = renderPrompt(suite, task, "goldenpc");
    assert.match(prompt, new RegExp(task.id));
    assert.match(prompt, /goldenpc/);
    assert.match(prompt, /Max steps|max steps/i);
    assert.doesNotMatch(prompt, /\{\{/);
    const lim = taskLimits(suite, task);
    assert.ok(lim.max_steps > 0);
    assert.ok(lim.timeout_sec > 0);
  });
});

describe("v2-artefact scorer", () => {
  it("exit0=true tool_calls=0 is not PASS", () => {
    const task = taskById("quotes-toscrape-pagination");
    const scored = scoreGoldenRow(task, {
      exit0: true,
      steps: 0,
      tool_calls: 0,
    });
    assert.notEqual(scored.verdict, "PASS");
    assert.equal(scored.exit0, true);
    assert.equal(
      scored.evidence.find((e) => e.clause === "min_tool_calls")?.status,
      "failed",
    );
  });

  it("row satisfying all clauses is PASS", () => {
    const task = taskById("books-toscrape-csv");
    const root = mkdtempSync(join(tmpdir(), "golden-pass-"));
    materializeArtifacts(task, root);
    const scored = scoreGoldenRow(task, {
      exit0: true,
      steps: 4,
      tool_calls: 4,
      workspaceRoot: root,
    });
    assert.equal(scored.verdict, "PASS");
    assert.ok(scored.evidence.every((e) => e.status === "satisfied"));
  });

  it("missing artefact fails", () => {
    const task = taskById("books-toscrape-csv");
    const root = mkdtempSync(join(tmpdir(), "golden-miss-"));
    mkdirSync(root, { recursive: true });
    const scored = scoreGoldenRow(task, {
      exit0: true,
      steps: 7,
      tool_calls: 7,
      workspaceRoot: root,
    });
    assert.equal(scored.verdict, "FAIL");
    assert.equal(
      scored.evidence.find((e) => e.clause === "artifact_glob")?.status,
      "failed",
    );
  });

  it("requires at least 15 parseable JSONL lines", () => {
    const task = taskById("quotes-toscrape-pagination");
    for (const [lines, verdict] of [[10, "FAIL"], [20, "PASS"]] as const) {
      const root = mkdtempSync(join(tmpdir(), `s3a-jsonl-${lines}-`));
      writeFileSync(
        join(root, "quotes.jsonl"),
        Array.from({ length: lines }, (_, i) =>
          JSON.stringify({ text: `quote ${i} ${"x".repeat(40)}`, author: `Author ${i}` }),
        ).join("\n") + "\n",
      );
      const scored = scoreGoldenRow(task, {
        exit0: true,
        steps: 3,
        tool_calls: 3,
        workspaceRoot: root,
      });
      assert.equal(scored.verdict, verdict);
      assert.equal(
        scored.evidence.find((e) => e.clause === "artifact_jsonl_min_lines")?.status,
        lines >= 15 ? "satisfied" : "failed",
      );
    }
  });

  it("mock run passes", () => {
    const suite = loadGoldenSuite();
    for (const task of suite.tasks) {
      const root = mkdtempSync(join(tmpdir(), `golden-mock-${task.id}-`));
      materializeArtifacts(task, root);
      const outcome = expectOutcome(task);
      const scored = scoreGoldenRow(task, {
        exit0: true,
        steps: Math.max(task.expect.min_tool_calls, 2),
        tool_calls: Math.max(task.expect.min_tool_calls, 2),
        workspaceRoot: root,
        events:
          outcome === "takeover"
            ? ["takeover.requested"]
            : outcome === "spend_cap"
              ? ["spend_cap"]
              : ["tool.call"],
        final_text:
          outcome === "complete"
            ? "Sauce Labs Backpack alice@example.com collected 16 unique quotes cheaper double-click Smith 03/15/2030"
            : outcome,
        takeover: outcome === "takeover",
        reason: outcome === "spend_cap" ? "spend_cap" : outcome === "takeover" ? "takeover" : "completed",
        notes: outcome === "spend_cap" ? "spend_cap hit" : "mock",
      });
      assert.equal(scored.verdict, "PASS", `${task.id}: ${evidenceSummary(scored.evidence)}`);
    }
  });

  it("spend_cap event fails when transcript mentions spend_cap but audit slice does not", () => {
    const task = taskById("spend-cap-negative");
    const scored = scoreGoldenRow(task, {
      exit0: false,
      steps: 2,
      tool_calls: 1,
      events: ["tool.call"],
      notes: "Plan: navigate example.com, keep stepping until spend_cap kill.",
      final_text: "keep stepping until spend_cap kill",
    });
    assert.equal(scored.verdict, "FAIL");
    const ev = scored.evidence.find((e) => e.clause === "event");
    assert.equal(ev?.status, "failed");
    assert.equal(ev?.detail, "text-only, no audit spend_cap");
  });

  it("policy.denied without reason spend_cap does not satisfy spend_cap", () => {
    const task = taskById("spend-cap-negative");
    const cases = [
      { events: ["policy.denied"], reason: "model_response" },
      { events: [{ type: "policy.denied", reason: "navigation_scheme" }] },
      { events: [{ type: "policy.denied", reason: "model_response" }] },
      { events: [{ type: "policy.denied", body: { reason: "strict_origin" } }] },
    ] as const;
    for (const input of cases) {
      const scored = scoreGoldenRow(task, {
        exit0: false,
        steps: 1,
        tool_calls: 1,
        notes: "unrelated",
        ...input,
      });
      assert.equal(scored.verdict, "FAIL", JSON.stringify(input));
      assert.equal(
        scored.evidence.find((e) => e.clause === "event")?.status,
        "failed",
        JSON.stringify(input),
      );
    }
  });

  it("policy.denied with reason spend_cap, spend_cap, and audit_spend satisfy", () => {
    const task = taskById("spend-cap-negative");
    const cases = [
      [{ type: "policy.denied", reason: "spend_cap" }],
      [{ type: "policy.denied", body: { reason: "spend_cap" } }],
      ["spend_cap"],
      ["audit_spend"],
    ] as const;
    for (const events of cases) {
      const scored = scoreGoldenRow(task, {
        exit0: false,
        steps: 1,
        tool_calls: 1,
        events: [...events],
        notes: "unrelated",
      });
      assert.equal(scored.verdict, "PASS", JSON.stringify(events));
      assert.equal(
        scored.evidence.find((e) => e.clause === "event")?.status,
        "satisfied",
        JSON.stringify(events),
      );
    }
  });

  it("empty artefact file fails min bytes", () => {
    const task = taskById("books-toscrape-csv");
    const root = mkdtempSync(join(tmpdir(), "golden-empty-"));
    writeFileSync(join(root, "books.csv"), "");
    const scored = scoreGoldenRow(task, {
      exit0: true,
      steps: 3,
      tool_calls: 3,
      workspaceRoot: root,
    });
    assert.equal(scored.verdict, "FAIL");
  });
});
