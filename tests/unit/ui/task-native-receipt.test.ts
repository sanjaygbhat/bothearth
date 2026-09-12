/**
 * Native Codex / Claude Code tasks have no BotHearth budget: the live facts and
 * the receipt label the proxy as an estimate, and a provider-limit pause is
 * Resume without a raised cap.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskView, receiptAskLine, terminalCopy } from "../../../src/ui/task.ts";
import { limitTime } from "../../../src/ui/runtime.ts";
import { installDom, type FakeElement } from "./fake-dom.ts";
import type { UiEvent } from "../../../src/types/contracts.ts";

type Json = Record<string, unknown>;

const ts = (minute: number, second = 0) =>
  new Date(Date.UTC(2026, 8, 8, 15, 30 + minute, second)).toISOString();

const RESET = "2026-09-11T17:21:00.000Z";

type Call = { method: string; path: string; body: Json | null };

function stub(routes: Record<string, Json>): { calls: Call[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    const key = String(path).split("?")[0]!;
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: key,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Json) : null,
    });
    if (method === "HEAD") return new Response(null, { status: 200 });
    const body = routes[key];
    return body ? Response.json(body) : Response.json({ ok: true });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const SESSION = {
  ok: true,
  csrf: "c",
  spend_cap_usd: null,
  execution_mode: "codex",
  budget_kind: "tool_proxy",
  budget: null,
};

function detail(task: Json, steps: Json[] = []): Record<string, Json> {
  return {
    "/api/v1/session": SESSION,
    "/api/v1/session/devices": { devices: [{ id: "dev_me", current: true }] },
    "/api/v1/approvals": { approvals: [] },
    "/api/v1/takeovers": { takeovers: [] },
    "/api/v1/tasks/t_1": {
      task: {
        id: "t_1",
        computer_id: "cmp_1",
        goal: "Organise my Gmail",
        adapter: "codex",
        created_at: ts(0),
        ...task,
      },
      steps: [{ kind: "task.started", body: {}, created_at: ts(0) }, ...steps],
    },
  };
}

async function mount(routes: Record<string, Json>) {
  const dom = installDom({ hash: "#/tasks/t_1" });
  const api = stub(routes);
  const view = new TaskView();
  const root = document.createElement("div") as unknown as FakeElement;
  await view.mount(root as unknown as HTMLElement, "t_1");
  await new Promise(setImmediate);
  return {
    view,
    root,
    calls: api.calls,
    facts: () => root.querySelectorAll(".facts .r").map((r) => r.textContent),
    receipt: () =>
      Object.fromEntries(
        root.querySelectorAll(".receipt div").map((row) => [
          row.querySelector("dt")!.textContent,
          row.querySelector("dd")!.textContent,
        ]),
      ) as Record<string, string>,
    buttons: () => root.querySelectorAll(".done-acts button").map((b) => b.textContent),
    button: (label: string) =>
      root.querySelectorAll(".done-acts button").find((b) => b.textContent === label),
    restore: () => {
      view.unmount();
      api.restore();
      dom.restore();
    },
  };
}

const event = (type: string, body: Json, at: string): UiEvent =>
  ({ type, ts: at, task_id: "t_1", body }) as UiEvent;

describe("a native task has no budget field", () => {
  it("labels the live total as an estimate and never draws a cap", async () => {
    const t = await mount(detail({
      status: "running", adapter: "codex", spend_usd: 0.18, spend_cap_usd: null, calls_cap: null,
    }));
    try {
      assert.equal(t.facts()[0], "Estimated tool use$0.18");
      assert.equal(t.root.querySelector(".facts .meter"), null);
      assert.doesNotMatch(t.root.textContent, /of \$|budget|calls_cap|Resume with a higher budget/);
      t.view.onEvent(event("usage", { usd_est: 1.7, steps: 20, tokens_in: 1, tokens_out: 1 }, ts(5)));
      assert.equal(t.facts()[0], "Estimated tool use$1.70");
    } finally {
      t.restore();
    }
  });

  it("keeps the receipt label as estimated tool use, not a bill", async () => {
    const t = await mount(detail({
      status: "completed", adapter: "codex", started_at: ts(0), finished_at: ts(4),
      duration_ms: 240_000, spend_usd: 0.42, spend_cap_usd: null, calls_cap: null,
      summary: { steps: 4, sites: [], asks: 0, files_saved: [], cost_usd: 0.42 },
    }, [
      { kind: "task.completed", body: { summary: "Done." }, created_at: ts(4) },
    ]));
    try {
      assert.equal(t.receipt()["Estimated tool use"], "$0.42");
      assert.equal(t.receipt()["Total cost"], undefined);
      assert.doesNotMatch(t.root.textContent, /of \$|budget/);
    } finally {
      t.restore();
    }
  });
});

describe("a native provider-limit pause", () => {
  const PAUSE = {
    status: "paused",
    reason: "provider_limit",
    failure_kind: "provider_limit",
    provider_limit_reason: "quota_exhausted",
    provider_limit_resets_at: RESET,
    detail: `Your Codex plan’s usage limit is reached; resets at ${RESET}.`,
  };

  it("says the plan ran out and offers Resume without a budget", async () => {
    const copy = terminalCopy({
      status: "paused",
      reason: "provider_limit",
      budget: null,
      took: null,
      terminal: PAUSE,
      adapter: "codex",
    });
    assert.equal(copy.kind, "paused");
    assert.equal(copy.limitReached, null);
    assert.equal(copy.planLimit?.reason, "quota_exhausted");
    assert.equal(
      copy.lede,
      `Your Codex plan’s usage limit is reached; resets at ${limitTime(RESET)}.`,
    );

    const t = await mount(detail({
      status: "paused", adapter: "codex", spend_cap_usd: null, calls_cap: null, failure_kind: "provider_limit",
    }, [
      { kind: "task.step", body: PAUSE, created_at: ts(4) },
    ]));
    try {
      assert.equal(
        t.root.querySelector(".done-lede")!.textContent,
        `Your Codex plan’s usage limit is reached; resets at ${limitTime(RESET)}.`,
      );
      assert.deepEqual(t.buttons(), ["Resume", "Run again", "Start another task", "Copy diagnostics"]);
      assert.equal(t.button("Resume with a higher budget"), undefined);
      t.button("Resume")!.click();
      await new Promise(setImmediate);
      const resume = t.calls.find((c) => c.path === "/api/v1/tasks/t_1/resume");
      assert.ok(resume, "Resume continues this task");
      assert.equal(resume.method, "POST");
      assert.equal(resume.body, null);
    } finally {
      t.restore();
    }
  });
});

const SIGN_IN_REASON =
  "GitHub’s sign-in page is open. Please sign in directly in the browser, including any two-factor verification or CAPTCHA, then return control.";

const SIGN_IN_STEPS = [
  { kind: "usage", body: { steps: 0, usd_est: 0 }, created_at: ts(0) },
  { kind: "task.step", body: { status: "running" }, created_at: ts(1) },
  { kind: "tool.call", body: { name: "browser_navigate" }, created_at: ts(2) },
  { kind: "usage", body: { steps: 1, usd_est: 0.01 }, created_at: ts(3) },
  { kind: "tool.call", body: { name: "request_takeover" }, created_at: ts(4) },
  {
    kind: "takeover.requested",
    body: { takeover_id: "tk_1", reason: SIGN_IN_REASON, field_kind: "password" },
    created_at: ts(5),
  },
  { kind: "usage", body: { steps: 2, usd_est: 0.02 }, created_at: ts(6) },
  { kind: "task.step", body: { status: "running" }, created_at: ts(7) },
];

describe("a cancelled takeover receipt", () => {
  it("names the sign-in ask, matches the live step count, and says you had control", async () => {
    assert.equal(
      receiptAskLine(SIGN_IN_REASON, "password", "github.com"),
      "Asked you to sign in (GitHub)",
    );

    const live = await mount(detail({
      status: "running", adapter: "codex", spend_usd: 0.02, spend_cap_usd: null, calls: 2, calls_cap: null,
    }, SIGN_IN_STEPS));
    let liveSteps: string | undefined;
    try {
      liveSteps = live.facts().find((row) => row.startsWith("Steps so far"));
      assert.equal(liveSteps, "Steps so far2");
    } finally {
      live.restore();
    }

    const routes = detail({
      status: "cancelled", adapter: "codex", started_at: ts(0), finished_at: ts(8),
      duration_ms: 57_000, spend_usd: 0.02, spend_cap_usd: null, calls: 2, calls_cap: null,
      summary: { steps: 2, sites: ["github.com"], asks: 1, files_saved: [], cost_usd: 0.02 },
    }, [
      ...SIGN_IN_STEPS,
      { kind: "takeover.started", body: { takeover_id: "tk_1" }, created_at: ts(7) },
      { kind: "task.cancelled", body: {}, created_at: ts(8) },
      { kind: "takeover.released", body: { takeover_id: "tk_1" }, created_at: ts(9) },
    ]);
    routes["/api/v1/takeovers"] = {
      takeovers: [{ id: "tk_1", computer_id: "cmp_1", task_id: "t_1", state: "agent" }],
    };
    const t = await mount(routes);
    try {
      assert.equal(t.root.querySelector(".done-lede")!.textContent, "Stopped while you had control");
      assert.equal(t.receipt()["Things it asked you"], "Asked you to sign in (GitHub)");
      assert.doesNotMatch(t.root.textContent, /Nothing — it did it all itself/);
      const stepsBtn = t.root.querySelectorAll(".side-head button")
        .find((b) => /step/.test(b.textContent ?? ""));
      assert.equal(stepsBtn?.textContent, "All 2 steps");
      assert.equal(liveSteps, "Steps so far2", "live and frozen counts are the same number");
    } finally {
      t.restore();
    }
  });
});
