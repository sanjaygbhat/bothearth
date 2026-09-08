import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { raisedCap, TaskView, spendCapLede } from "../../../src/ui/task.ts";
import { installDom, type FakeElement } from "./fake-dom.ts";
import type { UiEvent } from "../../../src/types/contracts.ts";

/**
 * The budget, end to end on the task screen: what it says while a run is
 * spending, what the receipt says once it stopped on the cap, and what it
 * offers instead of "run the whole thing again".
 *
 * The run this is written from spent 200 tool calls and $2.00 twice over while
 * the screen read "$0.00 of $2.00 budget", failed with "Something on this
 * machine got in its way", and offered no way to raise the cap.
 */

type Json = Record<string, unknown>;

const ts = (minute: number, second = 0) =>
  new Date(Date.UTC(2026, 8, 8, 15, 30 + minute, second)).toISOString();

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
  spend_cap_usd: 2,
  execution_mode: "standalone",
  budget: { default_usd: 2, max_usd: 10 },
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

describe("the budget meter while a task runs", () => {
  it("counts tool calls the moment the run is spending and nothing is priced", async () => {
    const t = await mount(detail({ status: "running", spend_usd: 0, spend_cap_usd: 2 }));
    try {
      assert.deepEqual(t.facts()[0], "Budget used$0.00 of $2.00", "nothing has happened yet");

      for (let i = 0; i < 3; i += 1) {
        t.view.onEvent(event("tool.call", { name: "browser_snapshot" }, ts(1, i)));
      }
      assert.equal(
        t.facts()[0],
        "Budget used3 tool calls",
        "$0.00 beside a run that is spending is the lie that hid a whole failure",
      );

      // The daemon's own counter and its cap outrank this page's tally.
      t.view.onEvent(
        event("usage", { usd_est: 0, steps: 3, calls: 160, calls_cap: 200 }, ts(2)),
      );
      assert.equal(t.facts()[0], "Budget used160 of 200 tool calls");
      const meter = t.root.querySelector(".meter")!;
      assert.equal(meter.classList.contains("warn"), true, "80 per cent of the calls is a warning");
      assert.match(meter.getAttribute("aria-label")!, /80 percent of its 200 tool calls used/);

      // A real price outranks the count again the moment one exists.
      t.view.onEvent(event("usage", { usd_est: 1.4, steps: 4, calls: 170 }, ts(3)));
      assert.equal(t.facts()[0], "Budget used$1.40 of $2.00");
    } finally {
      t.restore();
    }
  });

  it("takes the spend the daemon reports, and never lowers it", async () => {
    // The record is the only figure that survives a reload: the live ones ride
    // on events this page may never have seen.
    const t = await mount(detail({ status: "running", spend_usd: 1.25, spend_cap_usd: 4 }));
    try {
      assert.equal(t.facts()[0], "Budget used$1.25 of $4.00");
      t.view.onEvent(event("policy.denied", { reason: "spend_cap", cap_usd: 4, proxy_estimate_usd: 4 }, ts(9)));
      assert.equal(
        t.facts()[0],
        "Budget used$4.00 of $4.00",
        "the refusal names what it had actually spent when it was refused",
      );
    } finally {
      t.restore();
    }
  });
});

describe("a run that stopped on its budget", () => {
  const failed = (task: Json, steps: Json[] = []) =>
    detail(
      { status: "failed", started_at: ts(0), finished_at: ts(23), duration_ms: 1_380_000, ...task },
      [
        ...Array.from({ length: 4 }, (_, i) => ({
          kind: "tool.call",
          body: { name: "browser_snapshot" },
          created_at: ts(1, i),
        })),
        { kind: "usage", body: { usd_est: 2, steps: 200, calls: 200, calls_cap: 200 }, created_at: ts(22) },
        ...steps,
      ],
    );

  it("names the budget and what it bought, and never blames this machine", async () => {
    const t = await mount(
      failed({ spend_usd: 2, spend_cap_usd: 2, failure_kind: "spend_cap" }, [
        {
          kind: "task.failed",
          body: { reason: "runner_error", summary: "Error: Claude Code ended without marking the task done" },
          created_at: ts(23),
          result_id: 9,
        },
      ]),
    );
    try {
      assert.equal(
        t.root.querySelector(".done-lede")!.textContent,
        "It reached its $2.00 budget after 200 tool calls.",
      );
      assert.doesNotMatch(t.root.textContent, /Something on this machine/);
      // The receipt totals what it really spent, not the $0.00 the usage
      // events reported while the proxy was metering it.
      assert.equal(t.receipt()["Cost, on your Claude plan"], "$2.00 of your $2.00 budget");
      assert.deepEqual(t.buttons(), [
        "Resume with a higher budget",
        "Run again",
        "Start another task",
        "Copy diagnostics",
      ]);
    } finally {
      t.restore();
    }
  });

  it("resumes against a bigger budget rather than starting over", async () => {
    const t = await mount(failed({ spend_usd: 2, spend_cap_usd: 2, failure_kind: "spend_cap" }));
    try {
      t.button("Resume with a higher budget")!.click();
      await new Promise(setImmediate);
      const resume = t.calls.find((c) => c.path === "/api/v1/tasks/t_1/resume");
      assert.ok(resume, "the button resumes this task");
      assert.deepEqual(
        resume.body,
        { spend_cap_usd: 4 },
        "a resume with no bigger budget is refused by the daemon, so one travels with it",
      );
    } finally {
      t.restore();
    }
  });

  it("states the tool calls on the receipt when the run was never priced", async () => {
    const t = await mount(
      detail({ status: "failed", spend_cap_usd: 2, failure_kind: "spend_cap" }, [
        { kind: "usage", body: { usd_est: 0, steps: 200, calls: 200, calls_cap: 200 }, created_at: ts(22) },
      ]),
    );
    try {
      assert.equal(
        t.receipt()["Cost, on your Claude plan"],
        "200 of the 200 tool calls it was allowed",
      );
    } finally {
      t.restore();
    }
  });

  it("chooses how much higher to go, and says so when it cannot go higher", () => {
    assert.equal(raisedCap(2, null, 10), 4, "twice what it had");
    assert.equal(raisedCap(2, 8, 10), 8, "what the person set in Settings, when that is more");
    assert.equal(raisedCap(6, null, 10), 10, "never above what the daemon accepts");
    assert.equal(raisedCap(10, 50, 10), null, "already at the maximum: nothing to ask for");
    assert.equal(raisedCap(2, null, null), 4, "no known maximum, still twice what it had");
    assert.equal(raisedCap(null, 5, 10), 5, "no cap recorded: the figure that was set");
    assert.equal(raisedCap(null, null, null), null);

    assert.equal(spendCapLede("$2.00 budget", 1), "It reached its $2.00 budget after 1 tool call.");
    assert.equal(spendCapLede(null, null), "It reached the budget set for this task.");
  });
});

describe("a run a budget paused rather than failed", () => {
  // The daemon ends a capped harness or CLI run `paused`, not `failed`, and
  // refuses a resume that carries no raise (409 E_SPEND_CAP / E_LIMIT). A plain
  // "Resume" on that screen is a button that cannot work.
  const pausedOn = (kind: string, task: Json = {}) =>
    detail({ status: "paused", started_at: ts(0), failure_kind: kind, ...task }, [
      {
        kind: "task.step",
        body: { status: "paused", reason: kind, failure_kind: kind },
        created_at: ts(23),
      },
    ]);

  it("offers a higher budget on a spend-cap pause, and sends one", async () => {
    const t = await mount(pausedOn("spend_cap", { spend_usd: 2, spend_cap_usd: 2 }));
    try {
      assert.deepEqual(t.buttons(), [
        "Resume with a higher budget",
        "Run again",
        "Start another task",
        "Copy diagnostics",
      ]);
      assert.equal(t.button("Resume"), undefined, "a resume with nothing left to spend is refused");

      t.button("Resume with a higher budget")!.click();
      await new Promise(setImmediate);
      const resume = t.calls.find((c) => c.path === "/api/v1/tasks/t_1/resume");
      assert.ok(resume, "the button resumes this task");
      assert.deepEqual(resume.body, { spend_cap_usd: 4 }, "twice the budget it stopped on");
    } finally {
      t.restore();
    }
  });

  it("offers more steps on a step-cap pause, and sends them", async () => {
    const t = await mount(pausedOn("max_steps", { max_steps: 200 }));
    try {
      assert.equal(t.root.querySelector(".done-lede")!.textContent, "It reached its step limit.");
      assert.deepEqual(t.buttons(), [
        "Resume with more steps",
        "Run again",
        "Start another task",
        "Copy diagnostics",
      ]);

      t.button("Resume with more steps")!.click();
      await new Promise(setImmediate);
      const resume = t.calls.find((c) => c.path === "/api/v1/tasks/t_1/resume");
      assert.ok(resume, "the button resumes this task");
      assert.deepEqual(
        resume.body,
        { max_steps: 400 },
        "steps, not dollars: the daemon refuses the resume on the counter that stopped it",
      );
    } finally {
      t.restore();
    }
  });

  it("keeps the plain Resume for a pause no cap caused", async () => {
    const t = await mount(pausedOn("waiting_for_you"));
    try {
      assert.equal(t.buttons()[0], "Resume");
      t.button("Resume")!.click();
      await new Promise(setImmediate);
      const resume = t.calls.find((c) => c.path === "/api/v1/tasks/t_1/resume");
      assert.ok(resume, "the button resumes this task");
      assert.equal(resume.body, null, "nothing to raise, so nothing travels with it");
    } finally {
      t.restore();
    }
  });
});

describe("the receipt's files", () => {
  const promoted = [
    {
      kind: "download.promoted",
      body: { workspace_path: "/workspace/out/inbox.csv", item_name: "inbox.csv" },
      created_at: ts(5),
    },
    { kind: "download.promoted", body: { path: "/workspace/out/gmail-organised.md" }, created_at: ts(6),
    },
  ];

  it("lists every file the run saved, and opens the deliverable rather than raw JSON", async () => {
    const t = await mount(
      detail({ status: "completed", results_dir: "/Users/me/ModelBot/computers/cmp_1/workspace/out" }, [
        ...promoted,
        { kind: "task.completed", body: { reason: "completed", summary: "Done." }, created_at: ts(7), result_id: 9 },
      ]),
    );
    const anyGlobal = globalThis as unknown as Record<string, unknown>;
    const saved = anyGlobal["webkit"];
    const posted: Array<{ method: string; args: Json }> = [];
    anyGlobal["webkit"] = { messageHandlers: { modelbot: { postMessage: (m: never) => void posted.push(m) } } };
    try {
      assert.equal(t.receipt()["Files it saved"], "inbox.csv, gmail-organised.md");

      t.button("Open result")!.click();
      assert.deepEqual(posted.map((m) => m.method), ["revealFile"], "through the shell, never a navigation");
      assert.equal(posted[0]!.args["path"], "/workspace/out/gmail-organised.md");
      assert.match(
        String(posted[0]!.args["url"]),
        /\/api\/v1\/computers\/cmp_1\/files\?path=/,
        "the file it saved, not the terminal event at /results/9",
      );
      assert.equal(
        posted[0]!.args["resultsDir"],
        "/Users/me/ModelBot/computers/cmp_1/workspace/out",
        "so the shell can reveal the folder in Finder",
      );
    } finally {
      anyGlobal["webkit"] = saved;
      t.restore();
    }
  });

  it("says None and offers nothing to open when the run saved nothing", async () => {
    const t = await mount(
      detail({ status: "failed", failure_kind: "spend_cap", spend_cap_usd: 2 }, [
        { kind: "task.failed", body: { reason: "runner_error", summary: "Error: ended early" }, created_at: ts(23), result_id: 9 },
      ]),
    );
    try {
      // The row was missing entirely on a failure, so the one question the
      // product exists to answer had no answer at all.
      assert.equal(t.receipt()["Files it saved"], "None");
      assert.equal(t.button("Open result"), undefined);
    } finally {
      t.restore();
    }
  });
});

describe("a takeover the bot may have got wrong", () => {
  it("says what it thinks it is looking at, and takes “not needed” for an answer", async () => {
    const routes = detail({ status: "running" }, [
      { kind: "takeover.requested", body: { takeover_id: "tk_1", reason: "otp_field" }, created_at: ts(4) },
    ]);
    routes["/api/v1/takeovers"] = {
      takeovers: [{ id: "tk_1", computer_id: "cmp_1", task_id: "t_1", state: "takeover_requested" }],
    };
    const t = await mount(routes);
    try {
      const card = t.root.querySelector(".takeover-ask")!;
      assert.match(card.textContent, /It thinks this is a one-time-code field/);
      const acts = card.querySelectorAll(".acts button");
      assert.deepEqual(acts.map((b) => b.textContent), ["Take control ⌘⇧T", "Not needed, continue"]);
      assert.match(acts[0]!.className, /primary/, "taking control is still the first offer");
      assert.match(acts[1]!.className, /ghost/);

      acts[1]!.click();
      await new Promise(setImmediate);
      const declined = t.calls.find((c) => c.path === "/api/v1/takeover/tk_1/decline");
      assert.ok(declined, "declining goes to the daemon’s own decline route");
      assert.equal(declined.method, "POST");
    } finally {
      t.restore();
    }
  });

  it("offers no decline once the keyboard has already been handed over", async () => {
    const routes = detail({ status: "running" }, []);
    routes["/api/v1/takeovers"] = {
      takeovers: [{ id: "tk_1", computer_id: "cmp_1", task_id: "t_1", state: "resume_validating" }],
    };
    const t = await mount(routes);
    try {
      const acts = t.root.querySelectorAll(".takeover-ask .acts button");
      assert.deepEqual(acts.map((b) => b.textContent), ["Take control ⌘⇧T"]);
    } finally {
      t.restore();
    }
  });
});
