import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  taskCost,
  taskModelLabel,
  clockTime,
  collapseFeed,
  elapsedPrecise,
  elapsedText,
  feedLine,
  GOAL_HEAD_MAX,
  goalHead,
  isFinished,
  planLimit,
  renderInline,
  renderRich,
  statusWord,
  terminalCopy,
  toolLine,
  TaskView,
  type FeedLine,
} from "../../../src/ui/task.ts";
import { LivePanel } from "../../../src/ui/live/panel.ts";
import { limitTime } from "../../../src/ui/runtime.ts";
import { formatUsd } from "../../../src/ui/usage.ts";
import { installDom, type FakeElement } from "./fake-dom.ts";
import { EVENT_TYPES, TOOL_NAMES, type UiEvent } from "../../../src/types/contracts.ts";

const ts = (minute: number, second = 0): string =>
  new Date(Date.UTC(2026, 8, 7, 10, minute, second)).toISOString();

type Posted = Array<{ method: string; args: unknown }> & { restore(): void };

/**
 * Stand in for the Mac shell's message handler, so a click that is supposed to
 * cross the bridge can be seen crossing it. `installDom` points `window` at
 * `globalThis`, which is where `native.ts` looks for `webkit`.
 */
function bridgeSpy(): Posted {
  const anyGlobal = globalThis as unknown as Record<string, unknown>;
  const saved = anyGlobal["webkit"];
  const posted = [] as unknown as Posted;
  anyGlobal["webkit"] = {
    messageHandlers: {
      modelbot: {
        postMessage(message: { method: string; args: unknown }) {
          posted.push(message);
        },
      },
    },
  };
  posted.restore = () => {
    anyGlobal["webkit"] = saved;
  };
  return posted;
}

describe("status words (§2.1 — five words, never a raw status)", () => {
  it("says the same five things a person reads on home", () => {
    assert.deepEqual(statusWord("running"), { word: "Working", tone: "run" });
    assert.deepEqual(statusWord("running", { needsYou: true }), {
      word: "Waiting for you",
      tone: "warn",
    });
    assert.deepEqual(statusWord("running", { driving: true }), {
      word: "You’re driving",
      tone: "run",
    });
    assert.deepEqual(statusWord("completed"), { word: "Done", tone: "ok" });
    assert.deepEqual(statusWord("cancelled"), { word: "Stopped", tone: "neutral" });
    assert.deepEqual(statusWord("failed"), { word: "Couldn’t finish", tone: "danger" });
    assert.deepEqual(statusWord("paused"), { word: "Waiting for you", tone: "warn" });
  });

  it("never leaks an underscore status or an internal word", () => {
    for (const status of ["pending_approval", "takeover_requested", "resume_validating", "weird"]) {
      const view = statusWord(status);
      assert.doesNotMatch(view.word, /_|approval|takeover|epoch|daemon/i);
    }
  });

  it("knows which statuses are over", () => {
    assert.equal(isFinished("completed"), true);
    assert.equal(isFinished("failed"), true);
    assert.equal(isFinished("cancelled"), true);
    assert.equal(isFinished("running"), false);
    assert.equal(isFinished("paused"), false);
  });
});

describe("step lines (§2.3 — names are user-facing)", () => {
  it("says what happened, never the tool that did it", () => {
    assert.equal(
      toolLine("browser_navigate", { url: "https://google.com/flights?a=1" }),
      "Opened google.com/flights",
    );
    assert.equal(toolLine("browser_navigate", {}), "Opened a site");
    assert.equal(toolLine("browser_snapshot", {}), "Read the page");
    assert.equal(toolLine("files_write", { path: "/workspace/out/fares.csv" }), "Saved fares.csv");
    assert.equal(toolLine("shell_exec", {}), "Ran a command on its computer");
    assert.equal(toolLine("request_takeover", {}), "Asked for your help");
    // Bookkeeping a person has no use for is not a step at all.
    assert.equal(toolLine("takeover_status", {}), null);
    // An unknown tool still reads as English, not as an identifier.
    assert.equal(toolLine("browser_press_key", {}), "Press key");
  });

  it("turns a durable step and a live event into the same kind of line", () => {
    const durable = feedLine("tool.call", { name: "browser_navigate" });
    const live = feedLine("tool.call", {
      name: "browser_navigate",
      arguments: { url: "https://google.com/flights" },
    });
    assert.deepEqual(durable, { text: "Opened a site", voice: "do" });
    assert.deepEqual(live, { text: "Opened google.com/flights", voice: "do" });
  });

  it("announces a save from its result, never from the request", () => {
    assert.equal(
      feedLine("tool.call", { name: "write_file", arguments: { path: "out/today.md" } }),
      null,
      "a write that has not come back yet is not a saved file",
    );
    assert.deepEqual(
      feedLine("tool.result", {
        name: "write_file",
        arguments: { path: "out/today.md" },
        result: { ok: true },
      }),
      { text: "Saved today.md", voice: "do", artifact: "today.md" },
    );
    assert.equal(
      feedLine("tool.result", {
        name: "write_file",
        arguments: { path: "out/today.md" },
        result: { ok: false },
      }),
      null,
      "a write the computer refused is not a saved file",
    );
    // The durable projection keeps the tool name and drops its arguments.
    assert.equal(feedLine("tool.result", { name: "files_write" })!.text, "Saved a file");
    assert.equal(feedLine("tool.result", { name: "browser_navigate" }), null);
  });

  it("takes the byte count off the promotion, which is what landed", () => {
    assert.equal(
      feedLine("download.promoted", { path: "out/today.md", bytes: 227 })!.text,
      "Saved today.md (227 bytes)",
    );
    assert.equal(
      feedLine("download.promoted", { path: "out/today.md" })!.text,
      "Saved today.md",
    );
  });

  it("renders the bot’s own words as prose and everything else as one sentence", () => {
    assert.deepEqual(feedLine("assistant", { content: "I’ll search **nonstop** fares." }), {
      text: "I’ll search **nonstop** fares.",
      voice: "say",
      rich: true,
    });
    assert.equal(feedLine("usage", { steps: 4 }), null);
    assert.equal(feedLine("tool.result", { code: "ok" }), null);
    assert.equal(feedLine("task.step", { status: "running" }), null);
    assert.equal(feedLine("task.started", {})?.text, "Opened its computer");
    assert.equal(feedLine("task.cancelled", {})!.text, "You stopped the task");
    assert.equal(feedLine("task.cancelled", { cancelled_by: "ui" })!.text, "You stopped the task");
    assert.equal(
      feedLine("task.cancelled", { cancelled_by: "api" })!.text,
      "Stopped through the API",
    );
    assert.equal(
      feedLine("task.cancelled", { cancelled_by: "system" })!.text,
      "BotHearth stopped it",
    );
  });

  it("explains the awkward moments without blaming the person", () => {
    assert.match(feedLine("tool.error", {})!.text, /didn’t work, so it tried another way/);
    assert.equal(
      feedLine("policy.denied", { url: "https://ads.example.com/x" })!.text,
      "Held back from opening ads.example.com/x",
    );
    assert.equal(
      feedLine("approval.requested", { gate: "new_domain", tool: "browser_type" })!.text,
      "Asked you about submitting a form",
    );
    assert.equal(
      feedLine("approval.requested", { gate: "new_domain", tool: "browser_navigate" })!.text,
      "Asked you about opening a new site",
    );
    assert.match(feedLine("approval.expired", {})!.text, /stopped and waited for you/);
    assert.equal(feedLine("takeover.started", {})!.text, "Handed you the keyboard and the mouse");
    assert.equal(feedLine("takeover.released", {})!.text, "You handed control back");
  });

  it("carries no internal vocabulary in any line it can produce", () => {
    const banned = /browser_|files_|shell_|new_domain|external_send|control_epoch|computer_id|approval_id|takeover_id|daemon|bootstrap|CSRF/i;
    const kinds = [
      "assistant", "task.started", "task.completed", "task.failed", "task.cancelled",
      "tool.call", "tool.error", "policy.denied", "approval.requested", "approval.decided",
      "approval.expired", "takeover.requested", "takeover.started", "takeover.released",
      "takeover.declined", "takeover.expired", "download.promoted", "sandbox.oom",
    ];
    for (const kind of kinds) {
      const bodies: Array<Record<string, unknown>> = [
        {},
        { gate: "new_domain" },
        { reason: "password_field" },
      ];
      // `name` is a tool identifier on a call and a file name on a download,
      // so only feed it where it means the identifier.
      if (kind !== "download.promoted") bodies.push({ name: "browser_navigate" });
      for (const body of bodies) {
        const line = feedLine(kind, body);
        if (line && !line.rich) assert.doesNotMatch(line.text, banned, `${kind}: ${line.text}`);
      }
    }
  });

  it("labels a native browser step in words, not as 'browser type finished'", () => {
    assert.equal(
      feedLine("native_tool", { name: "browser_type", status: "completed" })!.text,
      "Typed on the page",
    );
    assert.equal(
      feedLine("native_tool", { name: "mcp__modelbot__browser_type", status: "started" })!.text,
      "Typed on the page",
    );
    assert.equal(
      feedLine("native_tool", {
        name: "browser_type",
        arguments: { text: "BotHearth test" },
        status: "completed",
      })!.text,
      "Typed “BotHearth test”",
    );
    assert.equal(
      feedLine("native_tool", { name: "mystery_gadget", status: "completed" })!.text,
      "mystery gadget · finished",
    );
    assert.equal(feedLine("widget.frobbed", {})!.text, "widget · frobbed");
  });

  it("never renders a daemon step kind as its raw id", () => {
    const kinds = new Set<string>(EVENT_TYPES);
    const root = join(dirname(fileURLToPath(import.meta.url)), "../../../src/daemon");
    const visit = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          visit(path);
          continue;
        }
        if (!name.endsWith(".ts")) continue;
        const src = readFileSync(path, "utf8");
        for (const match of src.matchAll(/emit\((?:opts,\s*)?["']([a-z][a-z0-9_.]+)["']/g)) {
          kinds.add(match[1]!);
        }
        for (const match of src.matchAll(/insertStep\([^,]+,\s*[^,]+,\s*["']([a-z][a-z0-9_.]+)["']/g)) {
          kinds.add(match[1]!);
        }
      }
    };
    visit(root);
    assert.ok(kinds.has("native_tool"), "daemon emits native_tool");
    assert.ok(kinds.has("tool.call"), "daemon emits tool.call");
    for (const kind of kinds) {
      const line = feedLine(kind, {});
      if (line) assert.notEqual(line.text, kind, `${kind} rendered as its raw id`);
    }
    for (const tool of TOOL_NAMES) {
      for (const status of ["started", "completed"] as const) {
        const line = feedLine("native_tool", { name: tool, type: tool, status });
        if (!line) continue;
        assert.notEqual(line.text, kindMangled(tool, status), `${tool} ${status}: ${line.text}`);
        assert.notEqual(line.text, tool, `${tool} rendered as its raw id`);
        assert.doesNotMatch(line.text, /browser type finished/i);
      }
    }
  });
});

function kindMangled(tool: string, status: "started" | "completed"): string {
  const label = tool.replaceAll("_", " ");
  return status === "completed" ? `${label} finished` : `Using ${label}`;
}

describe("feed collapsing", () => {
  it("collapses consecutive identical steps and keeps the latest time", () => {
    const rows = collapseFeed([
      { text: "Opened its computer", voice: "do", at: ts(2) },
      { text: "Read the page", voice: "do", at: ts(4, 1) },
      { text: "Read the page", voice: "do", at: ts(4, 2) },
      { text: "Read the page", voice: "do", at: ts(4, 3) },
      { text: "Read the page", voice: "do", at: ts(4, 9) },
      { text: "Clicked something on the page", voice: "do", at: ts(5) },
    ]);
    assert.deepEqual(
      rows.map((r) => [r.text, r.repeat]),
      [
        ["Opened its computer", 1],
        ["Read the page", 4],
        ["Clicked something on the page", 1],
      ],
    );
    assert.equal(rows[1]!.at, ts(4, 9));
  });

  it("never collapses the bot’s own prose, however repetitive", () => {
    const rows = collapseFeed([
      { text: "Still looking.", voice: "say", rich: true, at: ts(1) },
      { text: "Still looking.", voice: "say", rich: true, at: ts(2) },
    ]);
    assert.equal(rows.length, 2);
  });

  it("does not collapse across a different voice", () => {
    const rows = collapseFeed([
      { text: "Same", voice: "do", at: ts(1) },
      { text: "Same", voice: "stumble", at: ts(2) },
    ]);
    assert.equal(rows.length, 2);
  });

  it("does not collapse distinct tool calls that happen to share a verb", () => {
    const rows = collapseFeed([
      { text: "Read the page", voice: "do", at: ts(4, 1), callId: "step_a" },
      { text: "Read the page", voice: "do", at: ts(4, 2), callId: "step_b" },
      { text: "Read the page", voice: "do", at: ts(4, 3), callId: "step_c" },
    ]);
    assert.deepEqual(
      rows.map((r) => [r.text, r.repeat]),
      [
        ["Read the page", 1],
        ["Read the page", 1],
        ["Read the page", 1],
      ],
    );
  });
});

/** The lines one `write_file` really produces, in the order they land. */
function saveEvents(path: string, bytes: number, at: number): Array<FeedLine & { at: string }> {
  const line = (kind: string, body: Record<string, unknown>, second: number) => ({
    ...feedLine(kind, body)!,
    at: ts(at, second),
  });
  return [
    // The promotion, which is what proves the bytes landed.
    line("download.promoted", { path, item_name: path, bytes }, 0),
    // The live result, which knows the path but not the size.
    line("tool.result", { name: "write_file", arguments: { path }, result: { ok: true } }, 0),
    // The same result replayed from the durable projection, which keeps no
    // arguments at all, so it can only say that something was saved.
    line("tool.result", { name: "write_file" }, 1),
  ];
}

describe("one saved file is one line", () => {
  it("folds the promotion, the result and its durable replay into the fullest line", () => {
    const rows = collapseFeed(saveEvents("out/today.md", 227, 5));
    assert.equal(rows.length, 1, "three events, one save, one row");
    assert.equal(rows[0]!.text, "Saved today.md (227 bytes)");
    assert.equal(rows[0]!.repeat, 1, "and no ×n badge to discount");
  });

  it("keeps two different files apart, and a genuine re-save a minute later", () => {
    assert.equal(
      collapseFeed([...saveEvents("out/today.md", 227, 5), ...saveEvents("out/notes.md", 40, 5)]).length,
      2,
      "two files are two lines",
    );
    assert.equal(
      collapseFeed([...saveEvents("out/today.md", 227, 5), ...saveEvents("out/today.md", 300, 7)]).length,
      2,
      "the same file written again two minutes later happened twice",
    );
  });

  it("leaves everything that is not a save exactly as it was", () => {
    const read = (second: number) => ({
      ...feedLine("tool.call", { name: "browser_snapshot" })!,
      at: ts(5, second),
    });
    assert.deepEqual(
      collapseFeed([read(1), read(2), read(3), read(4)]).map((r) => [r.text, r.repeat]),
      [["Read the page", 4]],
      "the ×n collapse for repeated identical steps is untouched",
    );
  });
});

describe("markdown — asterisks never reach the DOM", () => {
  function render(text: string): FakeElement {
    const host = document.createElement("div") as unknown as FakeElement;
    renderRich(host as unknown as HTMLElement, text);
    return host;
  }

  it("renders research tables without losing escaped pipes, code, links or unsafe text", () => {
    const dom = installDom();
    try {
      const host = render("| Question | Answer |\n| :--- | ---: |\n| A \\| B | `x|y` |\n| [Source](https://example.org) | <img src=x onerror=alert(1)> |\n| Empty | |\n| malformed | extra | cell |\nAfter.");
      assert.equal(host.querySelectorAll("table").length, 1);
      assert.deepEqual(host.querySelectorAll("th").map(cell => cell.textContent), ["Question", "Answer"]);
      assert.equal(host.querySelector("th")!.getAttribute("scope"), "col");
      assert.deepEqual(host.querySelectorAll("td").map(cell => cell.textContent), ["A | B", "x|y", "Source", "<img src=x onerror=alert(1)>", "Empty", ""]);
      assert.equal(host.querySelector("a")!.href, "https://example.org/");
      assert.equal(host.querySelector("img"), null);
      assert.match(host.textContent, /malformed/);
      assert.match(host.textContent, /After\./);
      assert.equal(host.querySelector(".result-table")!.tabIndex, 0);
      assert.equal(render("````\n| A | B |\n| --- | --- |\n````").querySelector("table"), null);
    } finally { dom.restore(); }
  });

  it("renders bold, code, bullets and numbers as real elements", () => {
    const dom = installDom();
    try {
      const host = render("# Fares\n\nThe **cheapest** is `188`.\n\n- JetBlue\n- Alaska\n\n1. First\n2. Second");
      assert.equal(host.querySelectorAll("h3").length, 1);
      assert.equal(host.querySelectorAll("strong")[0]?.textContent, "cheapest");
      assert.equal(host.querySelectorAll("code")[0]?.textContent, "188");
      assert.equal(host.querySelectorAll("ul li").length, 2);
      assert.equal(host.querySelectorAll("ol li").length, 2);
      assert.doesNotMatch(host.textContent, /\*\*|^#/m);
    } finally {
      dom.restore();
    }
  });

  it("keeps a fenced block literal", () => {
    const dom = installDom();
    try {
      const host = render("Here:\n```\nrm -rf /\n```\ndone");
      assert.equal(host.querySelectorAll("pre").length, 1);
      assert.equal(host.querySelectorAll("pre")[0]?.textContent, "rm -rf /\n");
    } finally {
      dom.restore();
    }
  });

  it("links only http(s), and never executes what a website wrote", () => {
    const dom = installDom();
    try {
      const host = render(
        "See [flights](https://google.com/flights) and [bad](javascript:alert(1)).",
      );
      const links = host.querySelectorAll("a");
      assert.equal(links.length, 1);
      assert.equal(links[0]?.href, "https://google.com/flights");
      assert.equal(links[0]?.rel, "noopener noreferrer");
      // The refused link keeps its words and loses its power.
      assert.match(host.textContent, /bad/);
      assert.doesNotMatch(host.textContent, /javascript:/);
    } finally {
      dom.restore();
    }
  });

  it("treats markup in tool output as text, not as markup", () => {
    const dom = installDom();
    try {
      const host = document.createElement("p") as unknown as FakeElement;
      renderInline(host as unknown as ParentNode, "<script>alert(1)</script> **ok**");
      assert.equal(host.querySelectorAll("script").length, 0);
      assert.match(host.textContent, /<script>alert\(1\)<\/script>/);
      assert.equal(host.querySelectorAll("strong")[0]?.textContent, "ok");
    } finally {
      dom.restore();
    }
  });
});

describe("numbers a person can check", () => {
  it("shows only total cost and does not invent a price for unpriced calls", () => {
    assert.equal(taskCost({ usd: 0.18, calls: 40 }), "$0.18");
    assert.equal(taskCost({ usd: 0, calls: 200 }), "Not reported");
    assert.equal(taskCost({ usd: 0, calls: 0 }), "$0.00");
    assert.equal(taskCost({ usd: Number.NaN, calls: 0 }), "Not reported");
    assert.equal(taskCost({ usd: -1, calls: 0 }), "Not reported");
    assert.equal(taskCost({ usd: 0.001, calls: 1 }), "less than $0.01");
  });

  it("says how long it took in words a person would use", () => {
    assert.equal(elapsedText(ts(2), ts(6)), "4 minutes");
    assert.equal(elapsedText(ts(2), ts(3)), "60 seconds");
    assert.equal(elapsedPrecise(ts(2), ts(6, 12)), "4 min 12 s");
    assert.equal(elapsedText("nonsense", ts(6)), "");
  });

  it("times a step to the minute", () => {
    assert.match(clockTime(ts(2)), /\d{1,2}:\d{2}/);
    assert.equal(clockTime("nonsense"), "");
  });
});

/* -------------------------------------------------------------------------
 * The view itself, driven by synthetic events — the states a daemon without
 * Docker or a model cannot reach on its own.
 * ---------------------------------------------------------------------- */

type Json = Record<string, unknown>;

function stubApi(routes: Record<string, Json>, missing = new Set<string>()): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    const key = String(path).split("?")[0]!;
    if (missing.has(key)) return new Response(JSON.stringify({ error: "E_IO" }), { status: 404 });
    // A HEAD is the "is this file still there?" question, and anything not
    // listed as missing is there.
    if ((init?.method ?? "GET") === "HEAD") return new Response(null, { status: 200 });
    const body = routes[key];
    if (!body) return new Response("{}", { status: 404 });
    return Response.json(body);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Collects the toasts the view raises, which the fake DOM otherwise swallows. */
function toastSpy(): { texts: () => string[]; restore: () => void } {
  const doc = globalThis.document as unknown as { getElementById(id: string): unknown };
  const original = doc.getElementById.bind(doc);
  const region = document.createElement("div") as unknown as FakeElement;
  doc.getElementById = (id: string) => (id.startsWith("toast-") ? region : original(id));
  return {
    texts: () => region.children.map((node) => String(node.textContent)),
    restore: () => {
      doc.getElementById = original;
    },
  };
}

const RUNNING = {
  "/api/v1/session": { ok: true, csrf: "c", spend_cap_usd: 2, execution_mode: "standalone" },
  "/api/v1/tasks/t_1": {
    task: {
      id: "t_1",
      computer_id: "cmp_1",
      goal: "Find the 3 cheapest direct flights SFO→JFK next Friday",
      status: "running",
      created_at: ts(2),
    },
    steps: [
      { kind: "task.started", body: {}, created_at: ts(2) },
      { kind: "assistant", body: { content: "I’ll search **nonstop** fares." }, created_at: ts(2, 30) },
    ],
  },
  "/api/v1/approvals": { approvals: [] },
  "/api/v1/takeovers": { takeovers: [] },
  "/api/v1/session/devices": {
    devices: [
      { id: "dev_me", label: "This Mac", current: true },
      { id: "dev_phone", label: "Phone" },
    ],
  },
};

async function mountRunning(): Promise<{
  view: TaskView;
  root: FakeElement;
  restore: () => void;
}> {
  const dom = installDom({ hash: "#/tasks/t_1" });
  const unstub = stubApi(RUNNING);
  const view = new TaskView();
  const root = document.createElement("div") as unknown as FakeElement;
  await view.mount(root as unknown as HTMLElement, "t_1");
  await new Promise(setImmediate);
  return {
    view,
    root,
    restore: () => {
      view.unmount();
      unstub();
      dom.restore();
    },
  };
}

function event(type: string, body: Json, at: string, taskId = "t_1"): UiEvent {
  return { type, ts: at, task_id: taskId, body } as UiEvent;
}

function feedText(root: FakeElement): string[] {
  return root.querySelectorAll(".feed .step .what").map((n) => n.textContent);
}

const T1_CALLS = [
  "browser_navigate", "browser_snapshot",
  "browser_type", "browser_type", "browser_type", "browser_type", "browser_type",
  "browser_click", "browser_click", "browser_click", "browser_click",
  "browser_snapshot", "browser_snapshot",
  "browser_navigate", "browser_snapshot",
  "browser_navigate", "browser_snapshot",
  "write_file", "done",
] as const;

const T1_NAV_URLS = [
  "https://httpbin.org/forms/post",
  "https://example.com",
  "https://www.wikipedia.org",
] as const;

function t1NativeLog(opts: { sharedId?: boolean; live?: boolean } = {}): Array<{
  kind: string;
  body: Record<string, unknown>;
  created_at: string;
}> {
  const steps: Array<{ kind: string; body: Record<string, unknown>; created_at: string }> = [];
  let second = 10;
  let nav = 0;
  for (const [i, name] of T1_CALLS.entries()) {
    const startId = `step_s${i}`;
    const doneId = opts.sharedId === false ? `step_f${i}` : startId;
    steps.push({
      kind: "native_tool",
      body: { id: startId, name, type: "mcp_tool_call", status: "started" },
      created_at: ts(3, second++),
    });
    const callBody: Record<string, unknown> = { name };
    if (opts.sharedId !== false) callBody.id = startId;
    if (opts.live && name === "browser_navigate") {
      callBody.arguments = { url: T1_NAV_URLS[nav] ?? T1_NAV_URLS[2] };
      nav += 1;
    }
    steps.push({ kind: "tool.call", body: callBody, created_at: ts(3, second++) });
    if (name === "write_file") {
      steps.push({
        kind: "download.promoted",
        body: { path: "out/dogfood-autonomy-2.md", bytes: 2228 },
        created_at: ts(3, second++),
      });
      steps.push({
        kind: "tool.result",
        body: { name, result: { ok: true } },
        created_at: ts(3, second++),
      });
    }
    if (name !== "done") {
      steps.push({
        kind: "native_tool",
        body: { id: doneId, name, type: "mcp_tool_call", status: "completed" },
        created_at: ts(3, second++),
      });
    }
  }
  return steps;
}

function t1ActionLabels(live = false): string[] {
  let nav = 0;
  return T1_CALLS.map((name) => {
    if (name === "browser_navigate") {
      if (!live) return "Opened a site";
      const host = ["httpbin.org/forms/post", "example.com", "www.wikipedia.org"][nav] ?? "www.wikipedia.org";
      nav += 1;
      return `Opened ${host}`;
    }
    if (name === "browser_snapshot") return "Read the page";
    if (name === "browser_type") return "Typed on the page";
    if (name === "browser_click") return "Clicked something on the page";
    if (name === "write_file") return "Saved dogfood-autonomy-2.md (2 KB)";
    return "Wrapped up";
  });
}

const T1_ACTION_LABELS = t1ActionLabels();
const T1_LIVE_ACTION_LABELS = t1ActionLabels(true);

function actionLabels(root: FakeElement): string[] {
  return root.querySelectorAll(".feed .step.do")
    .map((node) => node.querySelector(".what")!.textContent)
    .filter((text) => text !== "Opened its computer");
}

describe("task view, driven by synthetic events", () => {
  it("shows this task's saved model and executor, and names missing historical models honestly", async () => {
    assert.equal(taskModelLabel({ adapter: "codex" }), "Codex · Model not recorded");
    const t = await mountWith({ "/api/v1/tasks/t_1": {
      ...RUNNING["/api/v1/tasks/t_1"], task: { ...RUNNING["/api/v1/tasks/t_1"].task,
        adapter: "codex", model: "gpt-6-astra", execution_mode: "orchestrator",
        executor: { adapter: "claude", model: "claude-fable-5-1" },
      },
    } });
    try {
      assert.equal(t.root.querySelector(".task-model")!.textContent,
        "Codex · gpt-6-astra · Subagents: Claude · claude-fable-5-1");
    } finally { t.restore(); }
  });

  it("can hide model narration while retaining user messages, tools and the final summary", async () => {
    const t = await mountRunning();
    try {
      const toggle = t.root.querySelector(".task-output-toggle input")!;
      assert.equal((toggle as unknown as HTMLInputElement).checked, true);
      t.view.onEvent(event("user", { content: "Keep the source links" }, ts(3)));
      t.view.onEvent(event("tool.call", { name: "browser_snapshot" }, ts(4)));
      (toggle as unknown as HTMLInputElement).checked = false;
      toggle.fire("change");
      assert.deepEqual(feedText(t.root), ["Opened its computer", "You: Keep the source links", "Read the page"]);
      t.view.onEvent(event("assistant", { content: "More narration" }, ts(5)));
      t.view.onEvent(event("native_tool", { type: "command_execution", name: "command_execution", status: "started",
        arguments: "private command arguments" }, ts(5, 1)));
      t.view.onEvent(event("native_tool", { type: "file_change", name: "file_change", status: "completed" }, ts(5, 2)));
      t.view.onEvent(event("task.completed", { summary: "The final answer" }, ts(6)));
      assert.equal(feedText(t.root).includes("More narration"), false);
      assert.ok(feedText(t.root).includes("Running a command"));
      assert.ok(feedText(t.root).includes("File edit finished"));
      assert.doesNotMatch(t.root.textContent, /private command arguments/);
      assert.equal(feedText(t.root).includes("The final answer"), true);
      assert.equal(localStorage.getItem("modelbot.show-model-messages"), "false");
      (toggle as unknown as HTMLInputElement).checked = true;
      toggle.fire("change");
      assert.ok(feedText(t.root).includes("More narration"));
      assert.ok(feedText(t.root).includes("I’ll search nonstop fares."));
    } finally { t.restore(); }
  });

  it("keeps the active question visible when model narration is hidden", async () => {
    const current = RUNNING["/api/v1/tasks/t_1"];
    const t = await mountWith({ "/api/v1/tasks/t_1": {
      ...current, task: { ...current.task, awaiting_message: true },
      steps: [...current.steps, { kind: "assistant", body: { content: "Which date should I use?" }, created_at: ts(3) }],
    } });
    try {
      const toggle = t.root.querySelector(".task-output-toggle input")!;
      (toggle as unknown as HTMLInputElement).checked = false;
      toggle.fire("change");
      assert.ok(feedText(t.root).includes("Which date should I use?"));
      assert.ok(!feedText(t.root).includes("I’ll search nonstop fares."));
      assert.equal(t.root.querySelector(".task-composer")!.hidden, false);
    } finally { t.restore(); }
  });

  it("recovers from a failed load and preserves the draft across a failed refresh", async () => {
    const missing = new Set(["/api/v1/tasks/t_1"]);
    const t = await mountWith({}, missing);
    try {
      assert.match(t.root.textContent, /Task not found on this BotHearth/);
      missing.clear();
      t.root.querySelectorAll("button").find(b => b.textContent === "Try again")!.click();
      await new Promise(setImmediate);
      assert.ok(t.root.querySelector("h1.task-goal"));
      assert.doesNotMatch(t.root.textContent, /Task not found on this BotHearth/);
      assert.equal(t.root.querySelector(".task-grid")!.hidden, false);
      assert.equal(feedText(t.root).length, 2);
      const draft = t.root.querySelector("textarea")!;
      draft.value = "Keep my unfinished message";
      missing.add("/api/v1/tasks/t_1");
      t.view.onEvent(event("task.step", { message: true }, ts(4)));
      await new Promise(setImmediate);
      assert.equal(t.root.querySelector("textarea"), draft);
      assert.equal(draft.value, "Keep my unfinished message");
      assert.equal(t.root.querySelector(".task-grid")!.hidden, false);
      missing.clear();
      t.view.onEvent(event("task.step", { message: true }, ts(5)));
      await new Promise(setImmediate);
      assert.doesNotMatch(t.root.textContent, /Task not found on this BotHearth/);
      assert.equal(draft.value, "Keep my unfinished message");
    } finally { t.restore(); }
  });

  it("does not let a late failed request replace the next task", async () => {
    const t = await mountRunning();
    const original = globalThis.fetch;
    let finish!: (response: Response) => void;
    globalThis.fetch = (async (path, init) => {
      if (String(path) === "/api/v1/tasks/t_1") return new Promise<Response>(resolve => { finish = resolve; });
      if (String(path) === "/api/v1/tasks/t_2") return Response.json({
        task: { ...RUNNING["/api/v1/tasks/t_1"].task, id: "t_2", goal: "Second task" }, steps: [],
      });
      return original(path, init);
    }) as typeof fetch;
    try {
      t.view.onEvent(event("task.step", { message: true }, ts(4)));
      t.view.update("t_2");
      await new Promise(setImmediate);
      finish(Response.json({}, { status: 503 }));
      await new Promise(setImmediate);
      assert.equal(t.root.querySelector("h1.task-goal")!.textContent, "Second task");
      assert.doesNotMatch(t.root.textContent, /couldn’t open|Couldn’t refresh/);
    } finally { globalThis.fetch = original; t.restore(); }
  });

  it("sets a neutral page title on the next task before its record arrives", async () => {
    const t = await mountWith(completed(null, [
      { kind: "task.started", body: {}, created_at: ts(2) },
      { kind: "task.completed", body: { summary: "All set." }, created_at: ts(4) },
    ]));
    const original = globalThis.fetch;
    let finish!: (response: Response) => void;
    globalThis.fetch = (async (path, init) => {
      if (String(path) === "/api/v1/tasks/t_2") {
        return new Promise<Response>(resolve => { finish = resolve; });
      }
      return original(path, init);
    }) as typeof fetch;
    try {
      assert.equal(document.title, "Done — BotHearth");
      t.view.update("t_2");
      assert.equal(document.title, "Task — BotHearth");
      finish(Response.json({
        task: { ...RUNNING["/api/v1/tasks/t_1"].task, id: "t_2", goal: "A fresh run", status: "running" },
        steps: [],
      }));
      await new Promise(setImmediate);
      assert.equal(document.title, "Working — BotHearth");
    } finally { globalThis.fetch = original; t.restore(); }
  });

  it("replays the durable feed, then folds live steps into the same timeline", async () => {
    const t = await mountRunning();
    try {
      assert.deepEqual(feedText(t.root), ["Opened its computer", "I’ll search nonstop fares."]);
      assert.match(t.root.querySelector("h1.task-goal")!.textContent, /3 cheapest direct flights/);

      t.view.onEvent(
        event("tool.call", { name: "browser_navigate", arguments: { url: "https://google.com/flights" } }, ts(3)),
      );
      t.view.onEvent(
        event(
          "tool.result",
          {
            name: "browser_navigate",
            arguments: { url: "https://google.com/flights" },
            result: { ok: true },
          },
          ts(3, 1),
        ),
      );
      for (let i = 0; i < 4; i += 1) {
        t.view.onEvent(event("tool.call", { name: "browser_snapshot" }, ts(4, i)));
      }
      assert.deepEqual(feedText(t.root), [
        "Opened its computer",
        "I’ll search nonstop fares.",
        "Opened google.com/flights",
        "Read the page×4",
      ]);
      // The URL bar of the live view follows the navigation that came back.
      assert.equal(t.root.querySelector(".view .url")!.textContent, "google.com/flights");
    } finally {
      t.restore();
    }
  });

  it("keeps the feed a polite log and marks only the step in flight", async () => {
    const t = await mountRunning();
    try {
      const feed = t.root.querySelector(".feed")!;
      assert.equal(feed.getAttribute("role"), "log");
      assert.equal(feed.getAttribute("aria-live"), "polite");
      assert.equal(feed.getAttribute("aria-label"), "What your bot is doing");
      t.view.onEvent(event("tool.call", { name: "browser_snapshot" }, ts(5)));
      const now = t.root.querySelectorAll(".step.now");
      assert.equal(now.length, 1);
      assert.equal(now[0]!.querySelector(".what")!.textContent, "Read the page");
    } finally {
      t.restore();
    }
  });

  it("merges live steps with their durable replay without inflating the count", async () => {
    const t = await mountRunning();
    const original = globalThis.fetch;
    const steps = [3, 4].map(second => ({
      kind: "tool.call", body: { name: "browser_navigate" }, created_at: ts(second),
    }));
    try {
      for (const step of steps) t.view.onEvent(event(step.kind, {
        ...step.body, arguments: { url: "https://example.com/mail" },
      }, step.created_at));
      globalThis.fetch = (async (path, init) => String(path) === "/api/v1/tasks/t_1"
        ? Response.json({ ...RUNNING["/api/v1/tasks/t_1"], steps })
        : original(path, init)) as typeof fetch;
      t.view.onEvent(event("task.step", { message: true }, ts(5)));
      await new Promise(setImmediate);
      assert.equal(feedText(t.root).filter(text => text.startsWith("Opened example.com/mail")).join(),
        "Opened example.com/mail×2", "richer live labels and distinct calls survive replay");
      assert.ok(!feedText(t.root).includes("Opened a site"), "replay must not add generic duplicates");
      assert.ok(t.root.querySelectorAll(".facts .r").some(node => node.textContent === "Steps so far2"));
    } finally { globalThis.fetch = original; t.restore(); }
  });

  it("keeps one row when a live native step, tool call, takeover or stop is later replayed from durable history", async () => {
    const t = await mountRunning();
    const original = globalThis.fetch;
    const native = { id: "step_nav1", name: "browser_navigate", type: "mcp_tool_call", status: "started" };
    const takeover = { takeover_id: "tk_signin", reason: "GitHub’s sign-in page is open. Please sign in there." };
    const replay = [
      ...RUNNING["/api/v1/tasks/t_1"].steps,
      { kind: "native_tool", body: native, created_at: ts(3, 7) },
      { kind: "tool.call", body: { name: "browser_navigate" }, created_at: ts(4) },
      { kind: "takeover.requested", body: takeover, created_at: ts(5, 7) },
      { kind: "task.cancelled", body: {}, created_at: ts(6, 7) },
    ];
    try {
      t.view.onEvent(event("native_tool", native, ts(3)));
      t.view.onEvent(event("tool.call", { name: "browser_navigate", arguments: { url: "https://github.com/login" } }, ts(4)));
      t.view.onEvent(event("takeover.requested", takeover, ts(5)));
      globalThis.fetch = (async (path, init) => String(path) === "/api/v1/tasks/t_1"
        ? Response.json({ ...RUNNING["/api/v1/tasks/t_1"], steps: replay })
        : original(path, init)) as typeof fetch;
      t.view.onEvent(event("task.cancelled", {}, ts(6)));
      await new Promise(setImmediate);
      const lines = feedText(t.root);
      assert.deepEqual(
        lines.filter(text => text.startsWith("Opened") && text !== "Opened its computer"),
        ["Opened github.com/login"],
      );
      assert.equal(lines.filter(text => text.includes("sign-in page is open")).join(),
        takeover.reason);
      assert.equal(lines.filter(text => text.startsWith("You stopped the task")).join(),
        "You stopped the task");
    } finally { globalThis.fetch = original; t.restore(); }
  });

  it("renders one action row per native call from a 19-call started/finished/tool.call log, with no ×", async () => {
    const t = await mountWith({
      "/api/v1/tasks/t_1": {
        ...RUNNING["/api/v1/tasks/t_1"],
        task: { ...RUNNING["/api/v1/tasks/t_1"].task, status: "completed", calls: 19 },
        steps: [
          { kind: "assistant", body: { content: "I’ll submit sample values." }, created_at: ts(0, 1) },
          ...t1NativeLog({ sharedId: false }),
        ],
      },
    });
    try {
      const stepsBtn = t.root.querySelectorAll("button")
        .find((button) => /^All \d+ steps$/.test(button.textContent ?? ""));
      assert.equal(stepsBtn?.textContent, "All 19 steps");
      stepsBtn!.click();
      assert.deepEqual(actionLabels(t.root), T1_ACTION_LABELS);
      assert.equal(t.root.querySelectorAll(".feed .step.do .rep").length, 0);
    } finally { t.restore(); }
  });

  it("keeps those 19 rows when live events are later replayed from durable history", async () => {
    const t = await mountRunning();
    const original = globalThis.fetch;
    const live = t1NativeLog({ sharedId: true, live: true });
    const durable = [
      ...RUNNING["/api/v1/tasks/t_1"].steps,
      ...t1NativeLog({ sharedId: true }),
    ];
    try {
      for (const step of live) t.view.onEvent(event(step.kind, step.body, step.created_at));
      assert.deepEqual(actionLabels(t.root), T1_LIVE_ACTION_LABELS);
      assert.equal(t.root.querySelectorAll(".feed .step.do .rep").length, 0);
      globalThis.fetch = (async (path, init) => String(path) === "/api/v1/tasks/t_1"
        ? Response.json({ ...RUNNING["/api/v1/tasks/t_1"], steps: durable })
        : original(path, init)) as typeof fetch;
      t.view.onEvent(event("task.step", { message: true }, ts(2)));
      await new Promise(setImmediate);
      assert.deepEqual(actionLabels(t.root), T1_LIVE_ACTION_LABELS);
      assert.equal(t.root.querySelectorAll(".feed .step.do .rep").length, 0);
    } finally { globalThis.fetch = original; t.restore(); }
  });

  it("marks the in-flight action until its finished event arrives", async () => {
    const t = await mountRunning();
    try {
      t.view.onEvent(event("native_tool", {
        id: "step_nav", name: "browser_navigate", type: "mcp_tool_call", status: "started",
      }, ts(3)));
      const inflight = t.root.querySelectorAll(".feed .step.do")
        .find(node => node.querySelector(".what")!.textContent === "Opened a site");
      assert.ok(inflight);
      assert.equal(inflight!.classList.contains("now"), true);
      t.view.onEvent(event("native_tool", {
        id: "step_nav", name: "browser_navigate", type: "mcp_tool_call", status: "completed",
      }, ts(3, 1)));
      const done = t.root.querySelectorAll(".feed .step.do")
        .find(node => node.querySelector(".what")!.textContent === "Opened a site");
      assert.ok(done);
      assert.equal(done!.classList.contains("now"), false);
      assert.equal(t.root.querySelectorAll(".feed .step.do")
        .filter(node => node.querySelector(".what")!.textContent === "Opened a site").length, 1);
    } finally { t.restore(); }
  });

  it("shows a single live total without a budget meter or limit", async () => {
    const t = await mountRunning();
    try {
      t.view.onEvent(event("usage", { usd_est: 0.18, steps: 8, tokens_in: 1, tokens_out: 1 }, ts(4)));
      assert.equal(t.root.querySelector(".task-bar .spend")!.textContent, "");
      assert.deepEqual(t.root.querySelectorAll(".facts .r").map(r => r.textContent), [
        "Total cost$0.18", "Steps so far8", "Files it has savedNone yet",
      ]);
      assert.equal(t.root.querySelector(".facts .meter"), null);
      t.view.onEvent(event("usage", { usd_est: 1.7, steps: 20, tokens_in: 1, tokens_out: 1 }, ts(5)));
      assert.equal(t.root.querySelector(".facts .r")!.textContent, "Total cost$1.70");
      assert.equal(t.root.querySelector(".facts .meter"), null);
    } finally { t.restore(); }
  });

  it("counts the files it saved, by name, once the write comes back", async () => {
    const t = await mountRunning();
    try {
      const write = { name: "files_write", arguments: { path: "/workspace/fares.csv" } };
      t.view.onEvent(event("tool.call", write, ts(6)));
      assert.equal(
        t.root.querySelectorAll(".facts .r")[2]!.textContent,
        "Files it has savedNone yet",
        "a write that has not come back yet is not a saved file",
      );
      t.view.onEvent(event("tool.result", { ...write, result: { ok: true } }, ts(6, 1)));
      assert.equal(
        t.root.querySelectorAll(".facts .r")[2]!.textContent,
        "Files it has savedfares.csv",
      );
    } finally {
      t.restore();
    }
  });

  it("shows one saved-file line, carrying the bytes the promotion reported", async () => {
    const t = await mountRunning();
    try {
      const write = { name: "write_file", arguments: { path: "/workspace/out/today.md", content: "x" } };
      t.view.onEvent(event("tool.call", write, ts(6)));
      t.view.onEvent(
        event("download.promoted", { path: "/workspace/out/today.md", item_name: "/workspace/out/today.md", bytes: 227 }, ts(6, 1)),
      );
      t.view.onEvent(event("tool.result", { ...write, result: { ok: true } }, ts(6, 2)));
      assert.deepEqual(
        feedText(t.root).filter((line) => line.startsWith("Saved")),
        ["Saved today.md (227 bytes)"],
      );
    } finally {
      t.restore();
    }
  });

  it("lists saved files while the task is still running, with Download and Open", async () => {
    const t = await mountRunning();
    try {
      assert.equal(t.root.querySelector(".task-left > .artifacts")!.hidden, true);
      t.view.onEvent(
        event("download.promoted", { path: "out/today.md", item_name: "today.md", bytes: 227 }, ts(6)),
      );
      const artifacts = t.root.querySelector(".task-left > .artifacts")!;
      assert.equal(artifacts.hidden, false);
      assert.match(artifacts.textContent, /Files it saved/);
      assert.deepEqual(artifacts.querySelectorAll(".file .n").map((n) => n.textContent), ["today.md"]);
      assert.match(artifacts.querySelector(".file .w")!.textContent, /227 bytes/);
      const download = artifacts.querySelector(".file a")!;
      assert.equal(download.textContent, "Download");
      assert.equal(download.className, "btn sm");
      assert.equal(
        download.href,
        "/api/v1/computers/cmp_1/files?path=out%2Ftoday.md",
      );
      assert.equal(download.download, "today.md");
      assert.equal(download.target, "");
      assert.equal(artifacts.querySelector(".file button")!.textContent, "Open");
      const zip = artifacts.querySelector(".artifacts-head a")!;
      assert.equal(zip.textContent, "Download all");
      assert.equal(zip.className, "btn sm");
      assert.equal(zip.href, "/api/v1/tasks/t_1/files.zip");
      assert.equal(zip.download, "t_1-files.zip");
      assert.doesNotMatch(artifacts.textContent, /On this computer/);
      const posted = bridgeSpy();
      const opened: unknown[][] = [];
      const win = window as unknown as { open: (...args: unknown[]) => null };
      const origOpen = win.open;
      win.open = (...args: unknown[]) => {
        opened.push(args);
        return null;
      };
      try {
        download.click();
        zip.click();
        assert.equal(posted.length, 0, "Download is a link, not a bridge call");
        assert.deepEqual(opened, [], "Download does not window.open");
        artifacts.querySelector(".file button")!.click();
        assert.match(String((posted[0]!.args as { url: string }).url), /inline=1/);
      } finally {
        win.open = origOpen;
        posted.restore();
      }
    } finally {
      t.restore();
    }
  });

  it("offers the host workspace path on this computer, and a way to copy it", async () => {
    const t = await mountWith({
      "/api/v1/tasks/t_1": {
        ...RUNNING["/api/v1/tasks/t_1"],
        task: {
          ...RUNNING["/api/v1/tasks/t_1"].task,
          workspace_dir: "/Users/me/ModelBot/computers/cmp_1/workspace",
        },
      },
    });
    try {
      const note = t.root.querySelector(".workspace-path")!;
      assert.match(note.textContent, /On this computer: \/Users\/me\/ModelBot\/computers\/cmp_1\/workspace/);
      assert.equal(note.querySelector("button")!.textContent, "Copy path");
    } finally {
      t.restore();
    }
  });

  it("replaying the durable feed twice does not double a single step", async () => {
    const t = await mountRunning();
    try {
      const before = feedText(t.root);
      // A terminal event triggers a refetch of exactly the same steps.
      t.view.onEvent(event("task.step", { status: "running" }, ts(3)));
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(feedText(t.root), before);
    } finally {
      t.restore();
    }
  });
});

/* -------------------------------------------------------------------------
 * The three states a daemon with no Docker and no model cannot reach.
 * ---------------------------------------------------------------------- */

const BIND = {
  task_id: "t_1",
  control_epoch: 1,
  origin: "about:blank",
  action_hash: "abc",
  expires: new Date(Date.now() + 94_000).toISOString(),
};

async function mountWith(
  routes: Record<string, Json>,
  missing?: Set<string>,
): Promise<{
  view: TaskView;
  root: FakeElement;
  restore: () => void;
}> {
  const dom = installDom({ hash: "#/tasks/t_1" });
  const unstub = stubApi({ ...RUNNING, ...routes }, missing);
  const view = new TaskView();
  const root = document.createElement("div") as unknown as FakeElement;
  await view.mount(root as unknown as HTMLElement, "t_1");
  // The device-id read decides whether a granted takeover is this page's.
  await new Promise(setImmediate);
  return {
    view,
    root,
    restore: () => {
      view.unmount();
      unstub();
      dom.restore();
    },
  };
}

describe("task view tabs", () => {
  function selectedTab(root: FakeElement): string | undefined {
    return root
      .querySelectorAll('[role="tab"]')
      .find((node) => node.getAttribute("aria-selected") === "true")?.dataset.tab;
  }

  it("opens a running task on Computer so the picture is first on a narrow viewport", async () => {
    const t = await mountRunning();
    try {
      assert.equal(t.root.querySelector(".task-grid")!.getAttribute("data-tab"), "computer");
      assert.equal(selectedTab(t.root), "computer");
      assert.ok(t.root.querySelector(".task-side"), "the live panel is in the tree");
      const take = t.root
        .querySelectorAll(".view-acts button")
        .find((node) => node.textContent.includes("Take control"));
      assert.ok(take);
      assert.equal(take.disabled, false);
      assert.equal(take.hidden, false);
    } finally {
      t.restore();
    }
  });

  it("opens a paused-without-takeover task on Task so Resume is visible", async () => {
    const current = RUNNING["/api/v1/tasks/t_1"];
    const t = await mountWith({
      "/api/v1/tasks/t_1": { ...current, task: { ...current.task, status: "paused" } },
    });
    try {
      assert.equal(t.root.querySelector(".task-grid")!.getAttribute("data-tab"), "task");
      assert.equal(selectedTab(t.root), "task");
      const resume = t.root
        .querySelectorAll(".done-acts button")
        .find((node) => node.textContent === "Resume");
      assert.ok(resume, "Resume lives on the Task pane");
      assert.equal(resume.hidden, false);
      assert.match(resume.className, /\bprimary\b/);
    } finally {
      t.restore();
    }
  });

  it("opens a paused takeover on Computer so Take control is first", async () => {
    const current = RUNNING["/api/v1/tasks/t_1"];
    const t = await mountWith({
      "/api/v1/tasks/t_1": { ...current, task: { ...current.task, status: "paused" } },
      "/api/v1/takeovers": {
        takeovers: [
          { id: "tk_1", computer_id: "cmp_1", task_id: "t_1", state: "takeover_requested" },
        ],
      },
    });
    try {
      assert.equal(t.root.querySelector(".task-grid")!.getAttribute("data-tab"), "computer");
      assert.equal(selectedTab(t.root), "computer");
    } finally {
      t.restore();
    }
  });

  it("keeps a finished task on the Task tab", async () => {
    const t = await mountWith(completed(null, [
      { kind: "task.started", body: {}, created_at: ts(2) },
      { kind: "task.completed", body: { summary: "All set." }, created_at: ts(4) },
    ]));
    try {
      assert.equal(t.root.querySelector(".task-grid")!.getAttribute("data-tab"), "task");
      assert.equal(selectedTab(t.root), "task");
    } finally {
      t.restore();
    }
  });

  it("keeps the tab the person picked across a refresh", async () => {
    const t = await mountRunning();
    try {
      const taskTab = t.root
        .querySelectorAll('[role="tab"]')
        .find((node) => node.dataset.tab === "task")!;
      taskTab.click();
      assert.equal(t.root.querySelector(".task-grid")!.getAttribute("data-tab"), "task");
      t.view.onEvent(event("task.step", { message: true }, ts(4)));
      await new Promise(setImmediate);
      assert.equal(t.root.querySelector(".task-grid")!.getAttribute("data-tab"), "task");
      assert.equal(selectedTab(t.root), "task");
    } finally {
      t.restore();
    }
  });
});

describe("task view — waiting for you", () => {
  it("restores the review instruction on reload and updates it without removing chat", async () => {
    const instruction = "Review the prepared FAQ answer before it is published.";
    const t = await mountWith({
      "/api/v1/tasks/t_1": { ...RUNNING["/api/v1/tasks/t_1"], steps: [
        { kind: "takeover.requested", body: { takeover_id: "tk_review", reason: instruction }, created_at: ts(3) },
      ] },
      "/api/v1/takeovers": { takeovers: [{ id: "tk_review", computer_id: "cmp_1", task_id: "t_1", state: "takeover_requested" }] },
    });
    try {
      assert.match(t.root.querySelector(".takeover-ask")!.textContent, /Review the prepared FAQ answer/);
      assert.equal(t.root.querySelector(".task-composer")!.hidden, false);
      t.view.onEvent(event("takeover.requested", { takeover_id: "tk_review", reason: "Check the revised wording and sources." }, ts(4)));
      await new Promise(setImmediate);
      assert.match(t.root.querySelector(".takeover-ask")!.textContent, /Check the revised wording/);
      assert.equal(t.root.querySelector(".task-composer")!.hidden, false);
    } finally { t.restore(); }
  });

  it("pins the approval in the feed column with its actions outside every scroller", async () => {
    const t = await mountWith({
      "/api/v1/approvals": {
        approvals: [
          {
            id: "apv_1",
            task_id: "t_1",
            status: "pending",
            tool: "files_write",
            gate: "external_send",
            args_json: JSON.stringify({ path: "/workspace/note.md", content: "fares" }),
            bind_json: JSON.stringify(BIND),
            created_at: ts(5),
          },
        ],
      },
    });
    try {
      const card = t.root.querySelector(".approval");
      assert.ok(card, "the approval is on screen");
      // In the feed column, above the feed — not inside it, and not a toast.
      const left = t.root.querySelector(".task-left")!;
      assert.equal(left.contains(card), true);
      assert.equal(t.root.querySelector(".feed")!.contains(card), false);

      const body = card.querySelector(".approval-body")!;
      const actions = card.querySelector(".approval-actions")!;
      assert.equal(body.contains(actions), false, "the action row is outside the scroller");
      assert.equal(actions.querySelectorAll("button").length, 2);
      // One countdown in the app, and it is the attention banner's.
      assert.equal(actions.querySelector(".timer"), null);
      assert.match(card.textContent, /Put “note\.md” on your Mac\?/);
      assert.equal(card.querySelector(".payload"), null, "the payload is not in the DOM yet");

      // The live view says it is paused, and says what that means.
      assert.equal(t.root.querySelector(".side-head .state")!.textContent, "Paused");
      assert.match(
        t.root.querySelector(".view-note")!.textContent,
        /Nothing happens on its computer until you answer/,
      );
    } finally {
      t.restore();
    }
  });
});

describe("task view — you’re driving", () => {
  it("shows the handoff, marks the frame, and offers the way back", async () => {
    const t = await mountWith({
      "/api/v1/takeovers": {
        takeovers: [
          { id: "tk_1", computer_id: "cmp_1", task_id: "t_1", state: "human", holder: "dev_me" },
        ],
      },
    });
    try {
      const card = t.root.querySelector(".driving");
      assert.ok(card);
      assert.match(card.textContent, /You’re driving/);
      assert.match(card.textContent, /Messages you send below go to the bot/);
      assert.equal(t.root.querySelector(".view")!.classList.contains("human"), true);
      assert.equal(t.root.querySelector(".side-head .state")!.textContent, "You are driving");
      // No "Take control" while you already have it (audit P2-15).
      const take = t.root.querySelectorAll(".view-acts button")[0]!;
      assert.equal(take.hidden, true);
    } finally {
      t.restore();
    }
  });

  it("offers Use a different Google account while this window is driving, and posts", async () => {
    const t = await mountWith({
      "/api/v1/takeovers": {
        takeovers: [
          { id: "tk_1", computer_id: "cmp_1", task_id: "t_1", state: "human", holder: "dev_me" },
        ],
      },
      "/api/v1/takeover/tk_1/google-account": { ok: true },
    });
    const inner = globalThis.fetch;
    const posts: string[] = [];
    globalThis.fetch = (async (path: string, init?: RequestInit) => {
      const key = String(path).split("?")[0]!;
      if ((init?.method ?? "GET") === "POST") posts.push(key);
      return inner(path, init);
    }) as typeof fetch;
    try {
      const google = t.root
        .querySelector(".driving")!
        .querySelectorAll("button")
        .find((node) => node.textContent === "Use a different Google account");
      assert.ok(google, "the driving card is missing Use a different Google account");
      assert.equal(google.disabled, false);
      google.click();
      await new Promise(setImmediate);
      assert.deepEqual(posts, ["/api/v1/takeover/tk_1/google-account"]);
    } finally {
      t.restore();
    }
  });

  it("counts the lease down while you drive, and says using it holds it open", async () => {
    const t = await mountWith({
      "/api/v1/takeovers": {
        takeovers: [
          {
            id: "tk_1",
            computer_id: "cmp_1",
            task_id: "t_1",
            state: "human",
            holder: "dev_me",
            expires_at: new Date(Date.now() + 581_000).toISOString(),
          },
        ],
      },
    });
    try {
      assert.match(
        t.root.querySelector(".driving")!.textContent,
        /Control pauses in 9:4\d unless you keep using it/,
      );
    } finally {
      t.restore();
    }
  });

  it("tells every other window someone else has control, and offers it nothing", async () => {
    const t = await mountWith({
      "/api/v1/takeovers": {
        takeovers: [
          { id: "tk_1", computer_id: "cmp_1", task_id: "t_1", state: "human", holder: "dev_phone" },
        ],
      },
    });
    try {
      assert.equal(t.root.querySelector(".driving"), null, "this window is not driving");
      assert.match(t.root.querySelector(".takeover-ask")!.textContent, /Someone else has control/);
      assert.equal(t.root.querySelector(".view")!.classList.contains("human"), false);
      assert.equal(
        t.root.querySelector(".side-head .state")!.textContent,
        "Someone else is driving",
      );
      // Nothing to press: a second client asking for the keyboard is refused.
      assert.equal(t.root.querySelectorAll(".view-acts button")[0]!.hidden, true);
      assert.equal(t.root.querySelector(".screen canvas")!.tabIndex, -1, "not a tab stop");
    } finally {
      t.restore();
    }
  });

  it("asks first when the bot is only requesting, and does not claim you are driving", async () => {
    const t = await mountWith({
      "/api/v1/takeovers": {
        takeovers: [
          { id: "tk_1", computer_id: "cmp_1", task_id: "t_1", state: "takeover_requested" },
        ],
      },
    });
    try {
      assert.ok(t.root.querySelector(".takeover-ask"));
      assert.equal(t.root.querySelector(".driving"), null);
      assert.equal(t.root.querySelector(".view")!.classList.contains("human"), false);
      assert.equal(t.root.querySelector(".side-head .state")!.textContent, "Paused");
    } finally {
      t.restore();
    }
  });
});

describe("task view — finished", () => {
  const done = (status: string, summary?: string) => ({
    "/api/v1/tasks/t_1": {
      task: {
        id: "t_1",
        computer_id: "cmp_1",
        goal: "Find the 3 cheapest direct flights SFO→JFK next Friday",
        status,
        created_at: ts(2),
        updated_at: ts(6, 12),
      },
      steps: [
        { kind: "task.started", body: {}, created_at: ts(2) },
        ...(summary
          ? [{ kind: `task.${status}`, body: { summary }, created_at: ts(6, 12), result_id: 9 }]
          : []),
      ],
    },
  });

  it("shows the result, the receipt and a way to start the next thing", async () => {
    const t = await mountWith(done("completed", "## Cheapest\n\n- JetBlue **$188**"));
    try {
      assert.equal(t.root.querySelector("h1")!.textContent, "Task completed");
      assert.equal(t.root.querySelector(".result strong")!.textContent, "$188");
      assert.equal(t.root.querySelector(".result li")!.textContent, "JetBlue $188");

      const acts = t.root.querySelectorAll(".done-acts button, .done-acts a");
      // No "Open result": this run saved no file, so there is no result to
      // open. It used to open the terminal event at the API — a page of raw
      // JSON, over the whole app in the Mac shell.
      assert.deepEqual(acts.map((a) => a.textContent), ["Start another task", "Run again"]);
      assert.equal(
        t.root.querySelectorAll(".done-acts a").length,
        0,
        "no anchor on the done screen can navigate the app to the API",
      );

      const receipt = t.root.querySelectorAll(".receipt dt").map((d) => d.textContent);
      assert.deepEqual(receipt, [
        "Time",
        "Total cost",
        "Sites it visited",
        "Things it asked you",
        "Files it saved",
        "Browser profile",
      ]);
      assert.equal(t.root.querySelectorAll(".receipt dd")[0]!.textContent, "4 min 12 s");
      assert.doesNotMatch(t.root.querySelectorAll(".receipt dd")[1]!.textContent, /budget|allowed|of \$/);

      // Nothing on this screen can still act on a task that is over.
      assert.equal(t.root.querySelector(".task-bar button")!.hidden, true);
      assert.equal(t.root.querySelector(".side-head .caps")!.textContent, "What it did");
      assert.equal(t.root.querySelector(".side-head .state")!.hidden, true);
      // Dropping the whole block when no frame
      // was kept is what left the right column 45% empty. It renders either way
      // now — as a deliberate, labelled state that says what is missing — and
      // the dead controls still go.
      assert.match(t.root.textContent, /Last screen/);
      assert.ok(t.root.querySelector(".view.kept-none"), "the frame is in its empty state");
      assert.match(
        t.root.querySelector(".view-empty")!.textContent,
        /No picture of the last screen was kept/,
      );
      assert.equal(t.root.querySelector(".view-acts"), null);
    } finally {
      t.restore();
    }
  });

  it("shows what it saved, from either download.promoted shape", async () => {
    // The screen built to prove "files land
    // where you can open them" showed no file. Two producers write that event
    // with two different key sets, and the reader knew only one of them — so a
    // promoted browser download never reached the row at all.
    const t = await mountWith({
      "/api/v1/tasks/t_1": {
        task: {
          id: "t_1",
          computer_id: "cmp_1",
          goal: "Save the boarding pass",
          status: "completed",
          created_at: ts(2),
          updated_at: ts(6, 12),
        },
        steps: [
          { kind: "task.started", body: {}, created_at: ts(2) },
          {
            kind: "download.promoted",
            body: { workspace_path: "/workspace/out/boarding-pass.pdf", item_name: "boarding-pass.pdf" },
            created_at: ts(5),
          },
          {
            kind: "download.promoted",
            body: { path: "/workspace/out/flights.csv" },
            created_at: ts(6),
          },
        ],
      },
    });
    try {
      assert.match(t.root.textContent, /Files it saved/);
      const names = t.root.querySelectorAll(".artifacts .file .n").map((n) => n.textContent);
      assert.deepEqual(names, ["boarding-pass.pdf", "flights.csv"]);
      assert.deepEqual(
        t.root.querySelectorAll(".artifacts .file a").map((a) => a.textContent),
        ["Download", "Download"],
      );
      const rowBtns = t.root.querySelectorAll(".artifacts .file button");
      assert.deepEqual(rowBtns.map((b) => b.textContent), ["Open", "Open"]);
      const posted = bridgeSpy();
      try {
        rowBtns[0]!.click();
        assert.deepEqual(posted.map((m) => m.method), ["revealFile"]);
        const args = posted[0]!.args as Record<string, unknown>;
        assert.match(
          String(args["url"]),
          /\/api\/v1\/computers\/cmp_1\/files\?path=%2Fworkspace%2Fout%2Fboarding-pass\.pdf&inline=1$/,
          "the shell still gets the existing /files route",
        );
        assert.equal(args["path"], "/workspace/out/boarding-pass.pdf");
      } finally {
        posted.restore();
      }
    } finally {
      t.restore();
    }
  });

  it("says so plainly when there is no result, and offers no export of nothing", async () => {
    const t = await mountWith(done("completed"));
    try {
      // The answer to "did it save anything?" is a receipt row that is always
      // there, not a lede that appeared on some screens and not others.
      assert.equal(t.root.querySelectorAll(".receipt dd")[4]!.textContent, "None");
      const acts = t.root.querySelectorAll(".done-acts button, .done-acts a");
      assert.deepEqual(acts.map((a) => a.textContent), ["Start another task", "Run again"]);
    } finally {
      t.restore();
    }
  });

  it("is calm about a stop and about a failure, and offers a way on", async () => {
    // Done said "Run again" and these two said "Try
    // again" — one action, two words, on adjacent screens. And both of them now
    // offer the diagnostics Done has nothing to diagnose.
    for (const [status, heading] of [
      ["cancelled", /You stopped it/],
      ["failed", /It couldn’t finish/],
    ] as const) {
      const t = await mountWith(done(status));
      try {
        assert.match(t.root.querySelector("h1")!.textContent, heading);
        assert.doesNotMatch(t.root.textContent, /error|failure|fatal|exception/i);
        const acts = t.root.querySelectorAll(".done-acts button").map((a) => a.textContent);
        assert.deepEqual(acts, ["Start another task", "Run again", "Copy diagnostics"]);
      } finally {
        t.restore();
      }
    }
  });
});

/* -------------------------------------------------------------------------
 * The receipt may only describe what happened. `src/daemon/agent-loop.ts` states
 * the same rule for the daemon's own copy of it.
 * ---------------------------------------------------------------------- */

/** A finished task, its frozen receipt, and the durable steps behind it. */
function completed(summary: Json | null, steps: Json[]): Record<string, Json> {
  return {
    "/api/v1/tasks/t_1": {
      task: {
        id: "t_1",
        computer_id: "cmp_1",
        goal: "Write up the day",
        status: "completed",
        created_at: ts(2),
        finished_at: ts(2, 8),
        duration_ms: 8000,
        results_dir: "/tmp/ws/out",
        ...(summary ? { summary } : {}),
      },
      steps,
    },
  };
}

describe("full research results", () => {
  it("keeps the preview on failure, then loads and copies the complete report", async () => {
    const preview = "Source-backed findings. ".repeat(800).slice(0, 16000);
    const full = preview + "\n\nFINAL RECOMMENDATION: publish the reviewed FAQ.";
    const resultUrl = "/api/v1/tasks/t_1/results/42";
    const missing = new Set([resultUrl]);
    const t = await mountWith({
      ...completed(null, [{ kind: "task.completed", body: { summary: preview, summary_truncated: true }, result_id: 42, created_at: ts(4) }]),
      [resultUrl]: { text: full, truncated: false },
    }, missing);
    try {
      let copied = "";
      navigator.clipboard.writeText = async text => { copied = text; };
      const read = t.root.querySelectorAll(".result-tools button").find(button => button.textContent === "Read full result")!;
      assert.ok(read);
      assert.match(t.root.querySelector(".result-note")!.textContent, /shortened/);
      read.click();
      await new Promise(setImmediate);
      assert.match(t.root.querySelector(".result-note")!.textContent, /Couldn’t load/);
      assert.equal(t.root.querySelector(".result")!.textContent, preview.trim());
      missing.delete(resultUrl);
      read.click();
      await new Promise(setImmediate);
      assert.match(t.root.querySelector(".result")!.textContent, /FINAL RECOMMENDATION/);
      assert.equal(read.hidden, true);
      const copy = t.root.querySelectorAll(".result-tools button").find(button => button.textContent === "Copy result")!;
      copy.click();
      await new Promise(setImmediate);
      assert.equal(copied, full);
      assert.match(t.root.querySelector(".result-note")!.textContent, /Result copied/);
      navigator.clipboard.writeText = async () => { throw new Error("clipboard denied"); };
      copy.click();
      await new Promise(setImmediate);
      assert.match(t.root.querySelector(".result-note")!.textContent, /Couldn’t copy/);
    } finally { t.restore(); }
  });

  it("labels the full-result bound honestly and discards a response after task navigation", async () => {
    const resultUrl = "/api/v1/tasks/t_1/results/42";
    const routes = {
      ...completed(null, [{ kind: "task.completed", body: { summary: "Preview", summary_truncated: true }, result_id: 42, created_at: ts(4) }]),
      [resultUrl]: { text: "Available part", truncated: true },
    };
    const t = await mountWith(routes);
    const fetchBefore = globalThis.fetch;
    try {
      t.root.querySelectorAll(".result-tools button")[0]!.click();
      await new Promise(setImmediate);
      assert.match(t.root.querySelector(".result-note")!.textContent, /exceeds the display limit/);
      assert.equal(t.root.querySelectorAll(".result-tools button")[1]!.textContent, "Copy preview");
      t.view.update("t_2");
      await new Promise(setImmediate);
      t.view.update("t_1");
      await new Promise(setImmediate);
      let resolve: (value: Response) => void = () => {};
      globalThis.fetch = (async (url, init) => String(url) === resultUrl
        ? await new Promise<Response>(done => { resolve = done; })
        : fetchBefore(url, init)) as typeof fetch;
      t.root.querySelectorAll(".result-tools button")[0]!.click();
      t.view.update("t_2");
      await new Promise(setImmediate);
      resolve(Response.json({ text: "WRONG_TASK_RESULT", truncated: false }));
      await new Promise(setImmediate);
      assert.doesNotMatch(t.root.textContent, /WRONG_TASK_RESULT/);
    } finally { globalThis.fetch = fetchBefore; t.restore(); }
  });
});

describe("task view — a request is not an outcome", () => {
  it("shows no file and no Open button for a write the computer refused", async () => {
    const t = await mountWith(
      completed(null, [
        { kind: "task.started", body: {}, created_at: ts(2) },
        {
          kind: "tool.call",
          body: { name: "write_file", arguments: { path: "out/today.md", content: "x" } },
          created_at: ts(2, 4),
        },
        {
          kind: "tool.error",
          body: {
            name: "write_file",
            arguments: { path: "out/today.md" },
            result: { ok: false, error: { code: "E_CAPABILITY", message: "cannot save files yet" } },
          },
          created_at: ts(2, 5),
        },
      ]),
    );
    try {
      assert.equal(t.root.querySelector(".artifacts"), null, "no file block at all");
      assert.doesNotMatch(t.root.textContent, /today\.md/);
      assert.deepEqual(
        t.root.querySelectorAll(".done-acts button").map((b) => b.textContent),
        ["Start another task", "Run again"],
        "and no Open button anywhere on the screen",
      );
      assert.equal(t.root.querySelectorAll(".receipt dd")[4]!.textContent, "None");
    } finally {
      t.restore();
    }
  });

  it("does not count a navigation that failed as a site it visited", async () => {
    const t = await mountWith(
      completed(null, [
        { kind: "task.started", body: {}, created_at: ts(2) },
        {
          kind: "tool.call",
          body: { name: "browser_navigate", arguments: { url: "https://blocked.example/x" } },
          created_at: ts(2, 4),
        },
        {
          kind: "tool.error",
          body: {
            name: "browser_navigate",
            arguments: { url: "https://blocked.example/x" },
            result: { ok: false, error: { code: "E_POLICY", message: "not allowed" } },
          },
          created_at: ts(2, 5),
        },
      ]),
    );
    try {
      const rows = t.root.querySelectorAll(".receipt dd").map((d) => d.textContent);
      assert.equal(rows[2], "None");
      assert.doesNotMatch(t.root.textContent, /blocked\.example/);
    } finally {
      t.restore();
    }
  });

  it("counts a navigation that came back", async () => {
    const t = await mountWith(
      completed(null, [
        { kind: "task.started", body: {}, created_at: ts(2) },
        {
          kind: "tool.result",
          body: {
            name: "browser_navigate",
            arguments: { url: "https://google.com/flights" },
            result: { ok: true },
          },
          created_at: ts(2, 5),
        },
      ]),
    );
    try {
      assert.equal(t.root.querySelectorAll(".receipt dd").map((d) => d.textContent)[2], "google.com");
    } finally {
      t.restore();
    }
  });
});

describe("task view — the frozen receipt is the whole file list", () => {
  it("does not let the feed put back a file the daemon checked and dropped", async () => {
    // The daemon has verified this task's files against the disk: only
    // `out/today.md` is there. The feed still carries the promotion event for a
    // second file, and that event used to add a row with a live Open button.
    const t = await mountWith(
      completed({ steps: 3, sites: [], asks: 0, files_saved: ["out/today.md"], cost_usd: null }, [
        { kind: "task.started", body: {}, created_at: ts(2) },
        { kind: "download.promoted", body: { path: "out/today.md", bytes: 227 }, created_at: ts(2, 4) },
        { kind: "download.promoted", body: { path: "out/phantom.md" }, created_at: ts(2, 5) },
      ]),
    );
    try {
      assert.deepEqual(
        t.root.querySelectorAll(".artifacts .file .n").map((n) => n.textContent),
        ["today.md"],
      );
      assert.doesNotMatch(t.root.textContent, /phantom/);
    } finally {
      t.restore();
    }
  });

  it("falls back to what it saw land when there is no receipt at all", async () => {
    const t = await mountWith(
      completed(null, [
        { kind: "task.started", body: {}, created_at: ts(2) },
        { kind: "download.promoted", body: { path: "out/today.md" }, created_at: ts(2, 4) },
      ]),
    );
    try {
      assert.deepEqual(
        t.root.querySelectorAll(".artifacts .file .n").map((n) => n.textContent),
        ["today.md"],
      );
    } finally {
      t.restore();
    }
  });

  it("names a promoted file by its name, not by its whole workspace path", async () => {
    const t = await mountWith(
      completed(null, [
        {
          kind: "download.promoted",
          // What `write_file` actually emits: `item_name` is the whole path.
          body: { path: "out/today.md", item_name: "out/today.md", bytes: 227 },
          created_at: ts(2, 4),
        },
      ]),
    );
    try {
      assert.deepEqual(
        t.root.querySelectorAll(".artifacts .file .n").map((n) => n.textContent),
        ["today.md"],
        "the live receipt reads the same as the re-opened one",
      );
    } finally {
      t.restore();
    }
  });
});

describe("task view — a dead Open button says so", () => {
  const RECEIPT = { steps: 3, sites: [], asks: 0, files_saved: ["out/today.md"], cost_usd: null };

  it("tells the person the file is gone and stops offering it", async () => {
    const t = await mountWith(
      completed(RECEIPT, [{ kind: "task.started", body: {}, created_at: ts(2) }]),
      new Set(["/api/v1/computers/cmp_1/files"]),
    );
    const posted = bridgeSpy();
    const toasts = toastSpy();
    try {
      const open = t.root.querySelectorAll(".artifacts .file button").find((b) => b.textContent === "Open")!;
      const download = t.root.querySelector(".artifacts .file a")!;
      assert.equal(open.textContent, "Open");
      open.click();
      // The reveal fires on the gesture; the answer about the file arrives a
      // tick later.
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal((open as unknown as { disabled?: boolean }).disabled, true, "no second dead click");
      assert.equal(download.getAttribute("href"), null);
      assert.equal(download.getAttribute("aria-disabled"), "true");
      assert.match(
        t.root.querySelector(".artifacts .file .w")!.textContent,
        /Not on its computer any more/,
      );
      assert.deepEqual(toasts.texts(), ["This file isn’t here any more."]);
    } finally {
      toasts.restore();
      posted.restore();
      t.restore();
    }
  });

  it("leaves a file that is still there alone", async () => {
    const t = await mountWith(
      completed(RECEIPT, [{ kind: "task.started", body: {}, created_at: ts(2) }]),
    );
    const posted = bridgeSpy();
    try {
      const open = t.root.querySelectorAll(".artifacts .file button").find((b) => b.textContent === "Open")!;
      open.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal((open as unknown as { disabled?: boolean }).disabled ?? false, false);
      assert.match(t.root.querySelector(".artifacts .file .w")!.textContent, /ready to open/);
    } finally {
      posted.restore();
      t.restore();
    }
  });
});

describe("task view — Last screen never shows an empty frame", () => {
  it("keeps the picture for the receipt and drops it when the view is torn down", () => {
    const dom = installDom({ hash: "#/tasks/t_1" });
    try {
      const panel = new LivePanel({ computerId: null });
      (panel as unknown as { hasFrame: boolean }).hasFrame = true;
      assert.equal(panel.hasPainted(), true);
      // The receipt labels the frame "Last screen", so closing for it keeps
      // what is on the canvas; every other close wipes it, and the receipt
      // then renders its "no picture was kept" line instead of a blank box.
      panel.close(true);
      assert.equal(panel.hasPainted(), true);

      const gone = new LivePanel({ computerId: null });
      (gone as unknown as { hasFrame: boolean }).hasFrame = true;
      gone.close();
      assert.equal(gone.hasPainted(), false);
    } finally {
      dom.restore();
    }
  });

  it("renders the frame it already has, and says the picture is this session's", async () => {
    const dom = installDom({ hash: "#/tasks/t_1" });
    const routes: Record<string, Json> = { ...RUNNING };
    const unstub = stubApi(routes);
    const view = new TaskView();
    const root = document.createElement("div") as unknown as FakeElement;
    await view.mount(root as unknown as HTMLElement, "t_1");
    await new Promise(setImmediate);
    try {
      const panel = (view as unknown as { panel: LivePanel }).panel;
      (panel as unknown as { hasFrame: boolean }).hasFrame = true;
      Object.assign(routes, completed(null, [{ kind: "task.started", body: {}, created_at: ts(2) }]));
      view.onEvent(event("task.completed", { summary: "Done" }, ts(6)));
      await new Promise(setImmediate);

      assert.match(root.textContent, /Last screen/);
      assert.equal(root.querySelector(".view.kept-none"), null, "the frame is still a frame");
      assert.equal(root.querySelector(".view-empty"), null, "no empty state over a real picture");
      assert.match(root.querySelector(".view-note")!.textContent, /in this session/);
      assert.ok(root.querySelector("canvas"), "the picture it holds is on screen");
    } finally {
      view.unmount();
      unstub();
      dom.restore();
    }
  });

  it("says no picture was kept when the canvas was wiped under the flag", async () => {
    // The live view wipes the canvas on every reconnect — a tab coming back
    // from the background, a reload's `pageshow` — so "a frame arrived once" is
    // not "a picture is held". The receipt used to draw the wiped canvas: an
    // empty box with no text at all, which is the one thing this state may not
    // be. It has to fall back to the honest line.
    const dom = installDom({ hash: "#/tasks/t_1" });
    const routes: Record<string, Json> = { ...RUNNING };
    const unstub = stubApi(routes);
    const view = new TaskView();
    const root = document.createElement("div") as unknown as FakeElement;
    await view.mount(root as unknown as HTMLElement, "t_1");
    await new Promise(setImmediate);
    try {
      const panel = (view as unknown as { panel: LivePanel }).panel;
      (panel as unknown as { hasFrame: boolean }).hasFrame = true;
      // A cleared canvas is transparent everywhere: alpha 0 on any pixel.
      (panel.canvas as unknown as { getContext: () => unknown }).getContext = () => ({
        getImageData: () => ({ data: [0, 0, 0, 0] }),
      });
      assert.equal(panel.hasPainted(), false);

      Object.assign(routes, completed(null, [{ kind: "task.started", body: {}, created_at: ts(2) }]));
      view.onEvent(event("task.completed", { summary: "Done" }, ts(6)));
      await new Promise(setImmediate);

      assert.match(root.textContent, /Last screen/);
      assert.ok(root.querySelector(".view.kept-none"), "the frame is in its empty state");
      assert.match(
        root.querySelector(".view-empty")!.textContent,
        /No picture of the last screen was kept/,
      );
      assert.equal(root.querySelector("canvas"), null, "never a bare, blank canvas");
    } finally {
      view.unmount();
      unstub();
      dom.restore();
    }
  });
});

describe("task view — nothing is written as markup", () => {
  it("never uses innerHTML in the task view or anything it draws with", async () => {
    const { readFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const UI = join(dirname(fileURLToPath(import.meta.url)), "../../../src/ui");
    for (const file of [
      "task.ts",
      "approval.ts",
      "takeover.ts",
      "live/panel.ts",
      "live/icons.ts",
      "live/session.ts",
      "live/coords.ts",
    ]) {
      const source = readFileSync(join(UI, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, file);
    }
  });
});

describe("a long goal cannot swallow the task view", () => {
  // The real one from the Gmail run: 3,348 characters rendered as a 1,620px
  // `h1`, which pushed the approval buttons and Take control off the column.
  const GIANT = `Organise the Gmail inbox for owner@example.com. ${"Label the noise, keep the invoices, archive the rest. ".repeat(65)}`;
  const GIANT_TASK = {
    task: { id: "t_1", computer_id: "cmp_1", goal: GIANT, status: "running", created_at: ts(2) },
    steps: [{ kind: "task.started", body: {}, created_at: ts(2) }],
  };
  const GATE_ASK = {
    approvals: [
      {
        id: "apv_1",
        task_id: "t_1",
        status: "pending",
        tool: "browser_navigate",
        gate: "new_domain",
        args_json: JSON.stringify({ url: "https://mail.google.com/" }),
        bind_json: JSON.stringify(BIND),
        created_at: ts(5),
      },
    ],
  };
  const TAKEOVER_ASK = {
    takeovers: [{ id: "tk_1", computer_id: "cmp_1", task_id: "t_1", state: "takeover_requested" }],
  };

  it("clamps the heading and puts the rest behind an expander", () => {
    assert.ok(GIANT.length > 3500, "the fixture has to be the size that broke it");
    const clamped = goalHead(GIANT);
    assert.ok(clamped.head.length <= GOAL_HEAD_MAX + 1, clamped.head);
    assert.match(clamped.head, /^Organise the Gmail inbox/);
    assert.match(clamped.head, /…$/);
    assert.equal(clamped.rest, GIANT.trim());

    // A goal that fits is left exactly as it is, with nothing to expand.
    const short = goalHead("Find the 3 cheapest direct flights SFO→JFK next Friday");
    assert.equal(short.rest, "");
    assert.doesNotMatch(short.head, /…$/);
  });

  it("keeps the approval card and every action out of the goal's way", async () => {
    const t = await mountWith({
      "/api/v1/tasks/t_1": GIANT_TASK,
      "/api/v1/approvals": GATE_ASK,
    });
    try {
      const left = t.root.querySelector(".task-left")!;

      // The three answers and the disclosure are siblings of the goal in the
      // column, never inside anything the goal can grow past.
      const card = left.querySelector(".approval")!;
      assert.equal(card.parentNode, left.querySelector(".task-surface"));
      assert.equal(left.querySelector(".goal-full")!.contains(card), false);
      assert.equal(t.root.querySelector(".feed")!.contains(card), false);
      assert.deepEqual(
        card.querySelectorAll(".approval-actions button").map((b) => b.textContent.replace(/\s+/g, " ").trim()),
        ["Don’t allow esc", "Allow this site for the task", "Allow once ↩"],
      );
      assert.match(card.querySelector(".disclose")!.textContent, /Show exactly what it will send/);
    } finally {
      t.restore();
    }
  });

  it("puts Take control in the card's own action row, not below the fold", async () => {
    const t = await mountWith({
      "/api/v1/tasks/t_1": GIANT_TASK,
      "/api/v1/takeovers": TAKEOVER_ASK,
    });
    try {
      const ask = t.root.querySelector(".takeover-ask")!;
      const acts = ask.querySelector(".acts")!;
      const take = acts.querySelectorAll("button")[0]!;
      assert.match(take.textContent.replace(/\s+/g, " "), /^Take control/);
      assert.equal(take.classList.contains("primary"), true);
      assert.equal(ask.parentNode, t.root.querySelector(".task-surface"));
      assert.equal(t.root.querySelector(".goal-full")!.contains(ask), false);
    } finally {
      t.restore();
    }
  });

  // The live view is the only screen that carries the goal — `renderOutcome`
  // replaces the column with the receipt — so the clamp and the announcement
  // are checked in the states a person actually waits in.
  for (const [state, routes, word] of [
    ["working", {}, "Working"],
    ["waiting on a gate", { "/api/v1/approvals": GATE_ASK }, "Waiting for you"],
    ["waiting to hand over", { "/api/v1/takeovers": TAKEOVER_ASK }, "Waiting for you"],
  ] as const) {
    it(`clamps the live heading and announces only the head while ${state}`, async () => {
      const { head } = goalHead(GIANT);
      const t = await mountWith({ "/api/v1/tasks/t_1": GIANT_TASK, ...routes });
      try {
        const left = t.root.querySelector(".task-left")!;
        assert.equal(t.root.querySelector("h1.task-goal")!.textContent, head);

        const more = left.querySelector(".goal-more")!;
        const full = left.querySelector(".goal-full")!;
        assert.equal(more.hidden, false, "a clamped goal offers the rest");
        assert.equal(more.textContent, "Show full task");
        assert.equal(full.hidden, true, "and does not render it until asked");
        more.click();
        assert.equal(full.hidden, false);
        assert.equal(full.textContent, GIANT.trim());
        assert.equal(more.getAttribute("aria-expanded"), "true");

        // Not `Waiting for you. Organise the Gmail inbox …` plus 3,300 more
        // characters, which is what the region read on the Gmail run.
        assert.equal(t.root.querySelector("p.sr-only")!.textContent, `${word}. ${head}`);
      } finally {
        t.restore();
      }
    });
  }
});

describe("a plan limit is not a fault on this Mac", () => {
  const CODEX_ERROR =
    "Error: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 11th, 2026 5:21 PM.";
  const RESET = "2026-09-11T17:21:00.000Z";
  // The fields the daemon's classifier puts on `task.failed`.
  const LIMIT_BODY = {
    reason: "runner_error",
    summary: CODEX_ERROR,
    provider_limit_reason: "quota_exhausted",
    provider_limit_resets_at: RESET,
  };

  it("reads the daemon's verdict instead of re-matching the error text", () => {
    assert.deepEqual(planLimit(LIMIT_BODY, "codex"), {
      reason: "quota_exhausted",
      provider: "Codex",
      resetAt: limitTime(RESET),
    });
    assert.deepEqual(planLimit({ provider_limit_reason: "rate_limited" }, "claude"), {
      reason: "rate_limited",
      provider: "Claude",
      resetAt: null,
    });
    // A direct-API run has no CLI plan to name, so it names none.
    assert.equal(planLimit({ provider_limit_reason: "quota_exhausted" }, null)?.provider, null);
    // The UI never decides this for itself: the same error text without the
    // daemon's verdict is just a failure.
    assert.equal(planLimit({ reason: "runner_error", summary: CODEX_ERROR }, "codex"), null);
    assert.equal(planLimit(null), null);
  });

  it("stops blaming the machine and offers the other AI instead", () => {
    const copy = terminalCopy({
      status: "failed",
      reason: "runner_error",
      budget: "$2.00 budget",
      took: "6 s",
      terminal: LIMIT_BODY,
      adapter: "codex",
    });
    assert.match(copy.lede, /Your Codex plan hit its limit/);
    assert.match(copy.lede, new RegExp(limitTime(RESET)!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(copy.lede, /this Mac|machine|got in its way/i);
    assert.equal(copy.planLimit?.reason, "quota_exhausted");

    // Every other runner error keeps the sentence it had.
    const other = terminalCopy({
      status: "failed",
      reason: "runner_error",
      budget: null,
      took: null,
      terminal: { reason: "runner_error", summary: "Error: ECONNREFUSED" },
    });
    assert.match(other.lede, /Something on this Mac/);
    assert.equal(other.planLimit, null);
  });

  it("leads with what happened and keeps the raw error in a details row", async () => {
    const t = await mountWith({
      "/api/v1/tasks/t_1": {
        task: {
          id: "t_1",
          computer_id: "cmp_1",
          goal: "Organise the Gmail inbox",
          status: "failed",
          adapter: "codex",
          created_at: ts(2),
        },
        steps: [
          { kind: "task.started", body: {}, created_at: ts(2) },
          { kind: "task.failed", body: LIMIT_BODY, created_at: ts(2, 6) },
        ],
      },
    });
    try {
      const lede = t.root.querySelector(".done-lede")!;
      assert.match(lede.textContent, /Your Codex plan hit its limit/);
      assert.doesNotMatch(lede.textContent, /this Mac/);
      // The exception text is behind a disclosure, and is not a result.
      assert.equal(t.root.querySelector(".result"), null);
      const detail = t.root.querySelector(".done-detail")!;
      assert.match(detail.textContent, /Error details/);
      assert.match(detail.textContent, /You've hit your usage limit/);

      const acts = t.root.querySelectorAll(".done-acts button").map((b) => b.textContent);
      assert.deepEqual(acts, ["Switch model connection", "Run again", "Start another task", "Copy diagnostics"]);
      t.root.querySelectorAll(".done-acts button")[0]!.click();
      assert.equal(location.hash, "#/settings/ai");
    } finally {
      t.restore();
    }
  });
});

describe("failure_kind — the daemon's own verdict, never a guess", () => {
  const HEADLINE_BAN = /^Error[:\s]/i;

  it("never puts the raw Error: string in the headline or the lede, for any kind", () => {
    const kinds = [
      "machine", "provider_limit", "waiting_for_you", "spend_cap",
      "max_steps", "stalled", "loop", "model_error",
    ] as const;
    for (const failure_kind of kinds) {
      const copy = terminalCopy({
        status: failure_kind === "waiting_for_you" ? "paused" : "failed",
        reason: "runner_error",
        budget: "$2.00 budget",
        took: "30 minutes",
        terminal: { failure_kind, summary: "Error: something exploded" },
      });
      assert.doesNotMatch(copy.heading, HEADLINE_BAN, failure_kind);
      assert.doesNotMatch(copy.lede, HEADLINE_BAN, failure_kind);
    }
  });

  it("says a machine problem in surface-neutral words", () => {
    const copy = terminalCopy({
      status: "failed", reason: "runner_error", budget: null, took: null,
      terminal: { failure_kind: "machine" },
    });
    assert.match(copy.lede, /Something on this machine got in its way/);
    assert.doesNotMatch(copy.lede, /this Mac\b/);
  });

  it("names how long it waited and offers Resume, not a fresh start", () => {
    const copy = terminalCopy({
      status: "paused", reason: "takeover", budget: null, took: "30 minutes",
      terminal: { failure_kind: "waiting_for_you" },
    });
    assert.equal(copy.kind, "paused");
    assert.match(copy.lede, /waited 30 minutes for you/);
    assert.match(copy.lede, /Resume to pick up where it left off/);
  });

  it("falls back to the generic paused line when no duration is known", () => {
    const copy = terminalCopy({
      status: "paused", reason: null, budget: null, took: null,
      terminal: { failure_kind: "waiting_for_you" },
    });
    assert.doesNotMatch(copy.lede, /waited/);
  });

  it("names the limit reached and offers to resume past it, for both caps", () => {
    const spend = terminalCopy({
      status: "failed", reason: "spend_cap", budget: "$2.00 budget", took: "6 s",
      terminal: { failure_kind: "spend_cap" },
    });
    assert.equal(spend.limitReached, "spend_cap");
    // The figures, not "it reached its budget limit": what it cost and what it
    // bought is the whole answer to "why did it stop?".
    assert.equal(spend.lede, "It reached its $2.00 budget.");

    const counted = terminalCopy({
      status: "failed", reason: "runner_error", budget: "$2.00 budget", took: "23 minutes",
      terminal: { failure_kind: "spend_cap" }, calls: 200,
    });
    assert.equal(counted.lede, "It reached its $2.00 budget after 200 tool calls.");
    assert.equal(counted.limitReached, "spend_cap");
    assert.doesNotMatch(counted.lede, /Something on this machine/);

    // A record written before `failure_kind` existed says the same in `reason`.
    const old = terminalCopy({
      status: "failed", reason: "spend_cap", budget: "$2.00 budget", took: null, calls: 1,
    });
    assert.equal(old.lede, "It reached its $2.00 budget after 1 tool call.");
    assert.equal(old.limitReached, "spend_cap");

    const steps = terminalCopy({
      status: "failed", reason: "max_steps", budget: null, took: "6 s",
      terminal: { failure_kind: "max_steps" },
    });
    assert.equal(steps.limitReached, "max_steps");
    assert.match(steps.lede, /reached its step limit/);

    // Every other kind leaves the raise-the-cap offer off the screen.
    assert.equal(terminalCopy({ status: "failed", reason: null, budget: null, took: null }).limitReached, null);
  });

  it("is honest about stalling and looping rather than blaming the machine", () => {
    const stalled = terminalCopy({
      status: "failed", reason: "stall", budget: null, took: null,
      terminal: { failure_kind: "stalled" },
    });
    assert.match(stalled.lede, /Resume to continue/);
    const pausedStall = terminalCopy({
      status: "paused", reason: "stall", budget: null, took: null,
      terminal: { failure_kind: "stalled" },
    });
    assert.equal(pausedStall.kind, "paused");
    assert.equal(pausedStall.limitReached, null);
    assert.match(pausedStall.lede, /Resume to continue/);

    const loop = terminalCopy({
      status: "failed", reason: "loop_detected", budget: null, took: null,
      terminal: { failure_kind: "loop" },
    });
    assert.match(loop.lede, /arriving back at the same step/);
  });

  it("still reads a provider limit from failure_kind with no legacy fields at all", () => {
    // The classic case (existing `provider_limit_reason` fields) is covered
    // above; this is the new contract on its own, degrading gracefully.
    const copy = terminalCopy({
      status: "failed", reason: "runner_error", budget: null, took: null,
      terminal: { failure_kind: "provider_limit" },
    });
    assert.doesNotMatch(copy.lede, /Something on this (Mac|machine)/);
  });

  it("falls back to the pre-existing reason wording when the record has no failure_kind at all", () => {
    // Older records never carried this field, and must read exactly as before.
    const copy = terminalCopy({
      status: "failed", reason: "loop_detected", budget: null, took: null,
      terminal: { reason: "loop_detected" },
    });
    assert.match(copy.lede, /arriving back at the same step/);
    assert.equal(copy.limitReached, null);
  });

  it("names who stopped the task without changing the sentence that follows", () => {
    const follow = "It stopped where it was. Anything it had already done stays done.";
    const ui = terminalCopy({
      status: "cancelled", reason: "cancelled", budget: null, took: null, cancelledBy: "ui",
    });
    assert.equal(ui.heading, "You stopped it");
    assert.equal(ui.lede, "You stopped it, and it stopped where it was.");

    const api = terminalCopy({
      status: "cancelled", reason: "cancelled", budget: null, took: null, cancelledBy: "api",
    });
    assert.equal(api.heading, "Stopped through the API");
    assert.equal(api.lede, follow);
    assert.doesNotMatch(api.heading, /You stopped it/);
    assert.doesNotMatch(api.lede, /You stopped it/);

    const system = terminalCopy({
      status: "cancelled", reason: "cancelled", budget: null, took: null, cancelledBy: "system",
    });
    assert.equal(system.heading, "BotHearth stopped it");
    assert.equal(system.lede, follow);
    assert.doesNotMatch(system.heading, /You stopped it/);

    const legacy = terminalCopy({
      status: "cancelled", reason: "cancelled", budget: null, took: null,
    });
    assert.equal(legacy.heading, "You stopped it");
  });
});

describe("failure_kind — paused and limit-reached screens offer the right actions", () => {
  // A pause carries `failure_kind` on `task.step` (`status: "paused"`), not on
  // a `task.paused` event — the daemon has no such event kind. `src/daemon/
  // agent-loop.ts` `finish()`: only completed/failed/cancelled get their own
  // event; everything else, paused included, is a `task.step`.
  function withTerminal(status: string, body: Json): Record<string, Json> {
    return {
      "/api/v1/tasks/t_1": {
        task: {
          id: "t_1", computer_id: "cmp_1", goal: "Book the flight", status,
          created_at: ts(2), updated_at: ts(6, 12),
        },
        steps: [
          { kind: "task.started", body: {}, created_at: ts(2) },
          {
            kind: status === "paused" ? "task.step" : "task.failed",
            body: status === "paused" ? { status: "paused", ...body } : body,
            created_at: ts(6, 12),
          },
        ],
      },
    };
  }

  it("leads with Resume over Run again on a waiting_for_you pause", async () => {
    const t = await mountWith(
      withTerminal("paused", { reason: "takeover", failure_kind: "waiting_for_you" }),
    );
    try {
      assert.match(t.root.querySelector("h1")!.textContent, /waiting for you/);
      assert.match(t.root.querySelector(".done-lede")!.textContent, /waited .* for you/);
      const acts = t.root.querySelectorAll(".done-acts button");
      assert.deepEqual(
        acts.map((b) => b.textContent),
        ["Resume", "Run again", "Start another task", "Copy diagnostics"],
      );
      assert.match(acts[0]!.className, /\bprimary\b/);
      assert.doesNotMatch(acts[1]!.className, /\bprimary\b/);
    } finally {
      t.restore();
    }
  });

  it("offers to resume past a spend cap ahead of running the whole thing again", async () => {
    const t = await mountWith(
      withTerminal("failed", { reason: "spend_cap", failure_kind: "spend_cap" }),
    );
    try {
      const acts = t.root.querySelectorAll(".done-acts button");
      assert.deepEqual(
        acts.map((b) => b.textContent),
        ["Resume with a higher budget", "Run again", "Start another task", "Copy diagnostics"],
      );
      assert.match(acts[0]!.className, /\bprimary\b/);
      assert.doesNotMatch(acts[1]!.className, /\bprimary\b/);
      assert.doesNotMatch(acts[2]!.className, /\bprimary\b/);
    } finally {
      t.restore();
    }
  });

  it("offers to resume past a step limit with its own label", async () => {
    const t = await mountWith(
      withTerminal("failed", { reason: "max_steps", failure_kind: "max_steps" }),
    );
    try {
      const acts = t.root.querySelectorAll(".done-acts button").map((b) => b.textContent);
      assert.deepEqual(acts, ["Resume with more steps", "Run again", "Start another task", "Copy diagnostics"]);
    } finally {
      t.restore();
    }
  });
});
