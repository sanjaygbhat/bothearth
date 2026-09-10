import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  blockerCard,
  composerState,
  createHomeView,
  EMPTY_RECENT,
  EXAMPLES,
  recentStatus,
  relativeTime,
} from "../../../src/ui/home.ts";
import type { RuntimeStatus } from "../../../src/ui/runtime.ts";
import type { Connection } from "../../../src/ui/connection.ts";
import { attention } from "../../../src/ui/native.ts";
import { resetSession } from "../../../src/ui/session.ts";
import { installDom, settle, type Dom, type FakeElement } from "./fake-dom.ts";

/* -------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------- */

const IMAGE = { present: true, created_at: "2026-09-01T00:00:00Z", stale: false };

function runtime(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    node: { ok: true, version: "22.18.0" },
    docker: { installed: true, running: true, engine: "orbstack", version: "1.0" },
    images: {
      computer: { ...IMAGE },
      shell: { ...IMAGE },
      proxy: { ...IMAGE },
      prepare: { state: "idle", step: "", percent: null, log_tail: [], error: null },
    },
    ai: {
      provider: "claude",
      cli_found: true,
      cli_path_kind: "path",
      logged_in: true,
      detail: "Signed in",
    },
    task_start_available: true,
    blockers: [],
    ...overrides,
  };
}

const DOCKER_MISSING = runtime({
  task_start_available: false,
  docker: { installed: false, running: false, engine: "unknown", version: "" },
  blockers: [
    {
      id: "docker_missing",
      title: "Give ModelBot its own computer",
      detail: "…",
      action: { kind: "open_url", url: "https://orbstack.dev/download" },
    },
  ],
});

const NO_AI = runtime({
  task_start_available: false,
  ai: { provider: null, cli_found: false, cli_path_kind: null, logged_in: null, detail: "" },
  blockers: [
    { id: "ai_not_connected", title: "Connect Claude or Codex", detail: "…", action: { kind: "open_url" } },
  ],
});

interface Server {
  runtime: RuntimeStatus;
  tasks: Array<Record<string, unknown>>;
  takeovers?: Array<Record<string, unknown>>;
  failTakeovers?: boolean;
  posts: Array<{ url: string; body: unknown }>;
  fail?: "network" | number;
  session?: Record<string, unknown>;
  failModels?: number;
  modelChecks?: number;
  connections?: Partial<Record<"codex" | "claude", Connection>>;
  models?: { providers: Array<{ id: string; label: string; default_model: string; start_available?: boolean; connected?: boolean;
    connection_status?: Connection["status"]; limit?: Connection["limit"]; models: Array<{ id: string; label: string }> }> };
}

/** Stands in for the daemon: three endpoints, and a record of what was posted. */
function serve(server: Server) {
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/v1/session") {
      return Response.json({ ok: true, csrf: "t", model: "claude-opus-4-5", execution_mode: "claude", ...server.session });
    }
    if (url === "/api/v1/runtime") {
      if (server.fail === "network") throw new TypeError("Failed to fetch");
      if (typeof server.fail === "number") {
        return Response.json({ error: "nope" }, { status: server.fail });
      }
      return Response.json(server.runtime);
    }
    if (url === "/api/v1/models") {
      server.modelChecks = (server.modelChecks ?? 0) + 1;
      if (server.failModels) return Response.json({ message: "Model check unavailable" }, { status: server.failModels });
      if (server.models) return Response.json(server.models);
    }
    if (url.startsWith("/api/v1/connection?provider=")) {
      const provider = url.split("=")[1] as "codex" | "claude";
      if (server.connections?.[provider]) return Response.json(server.connections[provider]);
    }
    if (url === "/api/v1/tasks" && method === "GET") {
      return Response.json({ tasks: server.tasks });
    }
    if (url === "/api/v1/takeovers") {
      if (server.failTakeovers) return Response.json({ error: "unavailable" }, { status: 503 });
      return Response.json({ takeovers: server.takeovers ?? [] });
    }
    if (url === "/api/v1/tasks" && method === "POST") {
      server.posts.push({ url, body: JSON.parse(String(init?.body ?? "null")) });
      return Response.json({ task: { id: "task_new" } }, { status: 201 });
    }
    return Response.json({ error: "unexpected", url }, { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = saved;
  };
}

const MODEL_CATALOG = {
  providers: [
    { id: "codex", label: "Codex", default_model: "gpt-6-astra", connected: true, start_available: true,
      models: [{ id: "gpt-6-astra", label: "GPT-6 Astra" }] },
    { id: "claude", label: "Claude", default_model: "claude-fable-5-1", connected: true, start_available: true,
      models: [{ id: "claude-fable-5-1", label: "Fable 5.1" }, { id: "claude-opus-5", label: "Opus 5" }] },
  ],
};

describe("task model choices", () => {
  it("routes a required licence to Settings and refreshes without starting a queued task", async () => {
    const server: Server = { runtime: runtime({ task_start_available: false, blockers: [{
      id: "licence_required", title: "Add your licence key", detail: "Get your key from your account.",
      action: { kind: "open_settings", url: "#/settings/licence" },
    }] }), tasks: [], posts: [], models: MODEL_CATALOG };
    const t = await mount(server);
    try {
      textarea(t.dom).value = "Read the public documentation";
      textarea(t.dom).fire("input");
      assert.equal(startButton(t.dom).getAttribute("aria-disabled"), "true");
      assert.match(t.dom.root.textContent, /Add your licence key to start/);
      const action = t.dom.root.querySelector(".blocker-actions")!.querySelector("button")!;
      action.click();
      assert.equal(t.dom.hash(), "#/settings/licence");
      startButton(t.dom).click();
      assert.deepEqual(server.posts, []);
      server.runtime = runtime();
      window.dispatchEvent(new Event("bothearth:licence-changed"));
      await settle(8);
      assert.equal(startButton(t.dom).getAttribute("aria-disabled"), "false");
      assert.equal(textarea(t.dom).value, "Read the public documentation");
      assert.deepEqual(server.posts, [], "activation never substitutes for Start task");
      startButton(t.dom).click();
      await settle(4);
      assert.equal(server.posts.length, 1);
    } finally { t.teardown(); }
  });

  it("keeps existing configured-model installations on their current runner", async () => {
    const server: Server = { runtime: runtime(), tasks: [], posts: [], models: MODEL_CATALOG,
      session: { execution_mode: "standalone", model: "configured-provider/exact-model" },
    };
    const t = await mount(server);
    try {
      assert.equal(t.dom.root.querySelector("#home-provider")!.value, "standalone");
      assert.equal(t.dom.root.querySelector("#home-model")!.value, "configured-provider/exact-model");
      assert.equal(t.dom.root.querySelector("#home-model")!.disabled, true);
      assert.equal(t.dom.root.querySelector("#home-orchestrator")!.disabled, true);
      textarea(t.dom).value = "Read a public page";
      textarea(t.dom).fire("input");
      startButton(t.dom).click();
      await settle(4);
      assert.deepEqual(server.posts[0]!.body, { goal: "Read a public page", capabilities: ["browser"] });
    } finally { t.teardown(); }
  });

  it("refreshes a changed configured default while preserving explicit native choices", async () => {
    const server: Server = { runtime: runtime(), tasks: [], posts: [], models: MODEL_CATALOG,
      session: { execution_mode: "standalone", model: "configured-old" },
    };
    const t = await mount(server);
    try {
      server.session = { execution_mode: "codex", model: "gpt-6-astra" };
      window.dispatchEvent(new Event("focus"));
      await settle(8);
      const provider = t.dom.root.querySelector("#home-provider")!;
      assert.equal(provider.value, "codex");
      assert.equal(t.dom.root.querySelector("#home-model")!.value, "gpt-6-astra");
      assert.equal(provider.children.some(option => option.value === "standalone"), false);
      provider.value = "claude";
      provider.fire("change");
      window.dispatchEvent(new Event("focus"));
      await settle(8);
      assert.equal(provider.value, "claude");
      assert.equal(t.dom.root.querySelector("#home-model")!.value, "claude-fable-5-1");
      textarea(t.dom).value = "Read the public documentation";
      textarea(t.dom).fire("input");
      startButton(t.dom).click();
      await settle(4);
      assert.equal((server.posts[0]!.body as Record<string, unknown>).adapter, "claude");
    } finally { t.teardown(); }
  });

  it("keeps exact choices and the draft across a failed model check, then retries before posting", async () => {
    const server: Server = { runtime: runtime(), tasks: [], posts: [], models: MODEL_CATALOG };
    const t = await mount(server);
    try {
      const model = t.dom.root.querySelector("#home-model")!;
      model.value = "__custom__";
      model.fire("change");
      const custom = t.dom.root.querySelector("#home-custom-model")!;
      const exactId = `provider/${"a".repeat(480)}@v1+long[context]`;
      custom.value = exactId;
      custom.fire("input");
      textarea(t.dom).value = "Read the documentation";
      textarea(t.dom).fire("input");
      server.failModels = 503;
      window.dispatchEvent(new Event("focus"));
      await settle(8);
      assert.equal(startButton(t.dom).getAttribute("aria-disabled"), "true");
      startButton(t.dom).click();
      await settle(2);
      assert.equal(server.posts.length, 0);
      assert.equal(custom.value, exactId);
      assert.equal(textarea(t.dom).value, "Read the documentation");
      assert.match(t.dom.root.textContent, /Retry before starting/);
      server.failModels = undefined;
      t.dom.root.querySelector(".home-model-retry")!.click();
      await settle(6);
      assert.equal(model.value, "__custom__");
      assert.equal(custom.value, exactId);
      startButton(t.dom).click();
      await settle(4);
      assert.equal((server.posts[0]!.body as Record<string, unknown>).model, exactId);
    } finally { t.teardown(); }
  });

  it("explains an older app's connected-model fallback without sending ignored choices", async () => {
    const server: Server = { runtime: runtime(), tasks: [], posts: [] };
    const t = await mount(server);
    try {
      assert.match(t.dom.root.querySelector(".home-model-hint")!.textContent, /connected model \(claude-opus-4-5\).*app update/);
      assert.equal(t.dom.root.querySelector(".home-model-fields")!.disabled, true);
      textarea(t.dom).value = "Read a public page";
      textarea(t.dom).fire("input");
      startButton(t.dom).click();
      await settle(4);
      assert.deepEqual(server.posts[0]!.body, { goal: "Read a public page", capabilities: ["browser"] });
    } finally { t.teardown(); }
  });

  it("uses the catalog for a chosen provider and starts each new task with Use subagents unchecked", async () => {
    const server: Server = { runtime: runtime(), tasks: [], posts: [], models: MODEL_CATALOG };
    const t = await mount(server);
    try {
      const provider = t.dom.root.querySelector("#home-provider")!;
      const model = t.dom.root.querySelector("#home-model")!;
      const orchestrator = t.dom.root.querySelector("#home-orchestrator")!;
      assert.equal((orchestrator as unknown as HTMLInputElement).checked, false);
      assert.equal((orchestrator as unknown as HTMLInputElement).type, "checkbox");
      assert.equal(orchestrator.getAttribute("role"), null);
      assert.equal(t.dom.root.querySelector(".home-orchestrator")!.textContent, "Use subagents");
      assert.equal(t.dom.root.querySelector("#home-executor-options")!.hidden, true);
      provider.value = "codex";
      provider.fire("change");
      assert.equal(model.value, "gpt-6-astra");
      const reasoning = t.dom.root.querySelector("#home-reasoning")!;
      assert.equal(reasoning.value, "medium");
      reasoning.value = "high";
      const box = textarea(t.dom);
      box.value = "Compare two public sites";
      box.fire("input");
      startButton(t.dom).click();
      await settle(4);
      assert.deepEqual(server.posts[0]!.body, { goal: box.value || "Compare two public sites", capabilities: ["browser"],
        adapter: "codex", model: "gpt-6-astra", execution_mode: "executor", reasoning_effort: "high" });
    } finally { t.teardown(); }
  });

  it("sends explicit subagent choices only when Use subagents is checked", async () => {
    const server: Server = { runtime: runtime(), tasks: [], posts: [], models: MODEL_CATALOG };
    const t = await mount(server);
    try {
      const orchestrator = t.dom.root.querySelector("#home-orchestrator")!;
      (orchestrator as unknown as HTMLInputElement).checked = true;
      orchestrator.fire("change");
      assert.equal((orchestrator as unknown as HTMLInputElement).checked, true);
      assert.equal(t.dom.root.querySelector("#home-executor-options")!.hidden, false);
      const provider = t.dom.root.querySelector("#executor-provider")!;
      provider.value = "codex";
      provider.fire("change");
      const model = t.dom.root.querySelector("#executor-model")!;
      model.value = "__custom__";
      model.fire("change");
      const custom = t.dom.root.querySelector("#executor-custom-model")!;
      custom.value = "custom-supported-model";
      custom.fire("input");
      const box = textarea(t.dom);
      box.value = "Check the public documentation";
      box.fire("input");
      startButton(t.dom).click();
      await settle(4);
      const body = server.posts[0]!.body as Record<string, unknown>;
      assert.equal(body.execution_mode, "orchestrator");
      assert.deepEqual(body.executor, { adapter: "codex", model: "custom-supported-model" });
      assert.equal(body.adapter, "claude");
      assert.equal(body.model, "claude-opus-4-5", "keep the configured model unless the person changes it");
    } finally { t.teardown(); }
    const next = await mount({ runtime: runtime(), tasks: [], posts: [], models: MODEL_CATALOG });
    try { assert.equal((next.dom.root.querySelector("#home-orchestrator") as unknown as HTMLInputElement).checked, false); }
    finally { next.teardown(); }
  });

  it("uses selected-provider readiness and rejects an invalid custom ID before posting", async () => {
    const server: Server = { runtime: NO_AI, tasks: [], posts: [], models: MODEL_CATALOG };
    const t = await mount(server);
    try {
      const provider = t.dom.root.querySelector("#home-provider")!;
      provider.value = "codex";
      provider.fire("change");
      const model = t.dom.root.querySelector("#home-model")!;
      model.value = "__custom__";
      model.fire("change");
      const custom = t.dom.root.querySelector("#home-custom-model")!;
      custom.value = "bad model with spaces";
      custom.fire("input");
      const box = textarea(t.dom);
      box.value = "Compare public pages";
      box.fire("input");
      startButton(t.dom).click();
      await settle(2);
      assert.equal(server.posts.length, 0);
      assert.match(t.dom.root.textContent, /Enter an exact model ID/);
      custom.value = "gpt-6-astra";
      custom.fire("input");
      startButton(t.dom).click();
      await settle(4);
      assert.equal(server.posts.length, 1, "the blocked global provider does not block the selected signed-in one");
    } finally { t.teardown(); }
  });

  it("checks the chosen subagent connection only when Use subagents is checked", async () => {
    const models = structuredClone(MODEL_CATALOG);
    models.providers[1]!.connected = false;
    models.providers[1]!.start_available = false;
    const server: Server = { runtime: runtime(), tasks: [], posts: [], models };
    const t = await mount(server);
    try {
      const provider = t.dom.root.querySelector("#home-provider")!;
      provider.value = "codex";
      provider.fire("change");
      const executor = t.dom.root.querySelector("#executor-provider")!;
      executor.value = "claude";
      executor.fire("change");
      const orchestrator = t.dom.root.querySelector("#home-orchestrator")!;
      (orchestrator as unknown as HTMLInputElement).checked = true;
      orchestrator.fire("change");
      textarea(t.dom).value = "Review public pages";
      textarea(t.dom).fire("input");
      assert.match(t.dom.root.textContent, /Check the Claude connection/);
      assert.equal(startButton(t.dom).getAttribute("aria-disabled"), "true");
      (orchestrator as unknown as HTMLInputElement).checked = false;
      orchestrator.fire("change");
      startButton(t.dom).click();
      await settle(4);
      assert.equal((server.posts[0]!.body as Record<string, unknown>).execution_mode, "executor");
      assert.equal((server.posts[0]!.body as Record<string, unknown>).executor, undefined);
    } finally { t.teardown(); }
  });

  it("keeps the detected model visible and guides signed-out accounts through Settings without queuing a task", async () => {
    const models = structuredClone(MODEL_CATALOG) as NonNullable<Server["models"]>;
    Object.assign(models.providers[0]!, { connected: false, start_available: false, connection_status: "signed_out" });
    const server: Server = { runtime: NO_AI, tasks: [], posts: [], models,
      session: { execution_mode: "codex", model: "gpt-6-astra" } };
    const t = await mount(server, { pill: true });
    try {
      const pill = t.dom.document.getElementById("tb-pill")!;
      assert.equal(t.dom.root.querySelector("#home-model")!.value, "gpt-6-astra");
      assert.equal(pill.querySelector(".label")!.textContent, "Codex · GPT-6 Astra");
      assert.match(pill.getAttribute("aria-label") ?? "", /Selected model: gpt-6-astra.*sign-in required/);
      assert.doesNotMatch(pill.textContent, /No model connected|on your plan/);
      assert.match(t.dom.root.textContent, /Sign in to Codex.*Your model is selected/);
      const signIn = t.dom.root.querySelector(".blocker-actions")!.querySelector("button")!;
      assert.equal(signIn.textContent, "Sign in");
      signIn.click();
      assert.equal(t.dom.hash(), "#/settings/ai?pick=codex");
      textarea(t.dom).value = "Read this public site";
      textarea(t.dom).fire("input");
      startButton(t.dom).click();
      assert.equal(startButton(t.dom).textContent, "Start task");

      models.providers[0]!.connection_status = "signing_in";
      await new Promise(resolve => setTimeout(resolve, 25));
      await settle(8);
      assert.match(t.dom.root.textContent, /Finish signing in to Codex/);
      assert.match(pill.textContent, /finish sign-in/);
      assert.equal(startButton(t.dom).getAttribute("aria-disabled"), "true");

      Object.assign(models.providers[0]!, { connected: true, start_available: true, connection_status: "connected" });
      server.runtime = runtime();
      location.hash = "#/";
      await settle(8);
      assert.equal(startButton(t.dom).getAttribute("aria-disabled"), "false");
      assert.equal(textarea(t.dom).value, "Read this public site");
      assert.equal(t.dom.root.querySelector("#home-model")!.value, "gpt-6-astra");
      assert.match(pill.textContent, /on your plan/);
      assert.deepEqual(server.posts, [], "finishing sign-in does not silently start the draft");
    } finally { t.teardown(); }
  });

  it("refreshes selected-provider authentication automatically even while the global provider is ready", async () => {
    const models = structuredClone(MODEL_CATALOG) as NonNullable<Server["models"]>;
    Object.assign(models.providers[0]!, { connected: false, start_available: false, connection_status: "signed_out" });
    const server: Server = { runtime: runtime(), tasks: [], posts: [], models };
    const t = await mount(server);
    try {
      const provider = t.dom.root.querySelector("#home-provider")!;
      provider.value = "codex";
      provider.fire("change");
      textarea(t.dom).value = "Check a public page";
      textarea(t.dom).fire("input");
      assert.equal(startButton(t.dom).getAttribute("aria-disabled"), "true");
      await settle(8);
      const before = server.modelChecks!;
      // The official CLI signs in externally. No focus, reload or Settings event.
      Object.assign(models.providers[0]!, { connected: true, start_available: true, connection_status: "signed_in" });
      await new Promise(resolve => setTimeout(resolve, 25));
      await settle(8);
      assert.ok(server.modelChecks! > before, "selected readiness remains in the existing poll loop");
      assert.equal(startButton(t.dom).getAttribute("aria-disabled"), "false");
      assert.equal(provider.value, "codex");
      assert.equal(t.dom.root.querySelector("#home-model")!.value, "gpt-6-astra");
      assert.deepEqual(server.posts, []);

      // Ready polls stop; returning to the tab must still notice a later sign-out.
      Object.assign(models.providers[0]!, { connected: false, start_available: false, connection_status: "signed_out" });
      window.dispatchEvent(new Event("focus"));
      await settle(8);
      assert.equal(startButton(t.dom).getAttribute("aria-disabled"), "true");
      assert.match(t.dom.root.textContent, /Sign in to Codex/);
    } finally { t.teardown(); }
  });

  it("separates a provider limit from sign-in and uses connection metadata on older catalogs", async () => {
    const models = structuredClone(MODEL_CATALOG) as NonNullable<Server["models"]>;
    Object.assign(models.providers[0]!, { start_available: false });
    const server: Server = { runtime: runtime(), tasks: [], posts: [], models,
      session: { execution_mode: "codex", model: "gpt-6-astra" },
      connections: { codex: { status: "connected", provider: "codex", model: "gpt-6-astra",
        limit: { reason: "quota_exhausted", resets_at: null } } } };
    const t = await mount(server, { pill: true });
    try {
      const pill = t.dom.document.getElementById("tb-pill")!;
      assert.match(pill.textContent, /Codex · GPT-6 Astra.*plan limit reached/);
      assert.match(t.dom.root.textContent, /Codex limit reached.*Codex is signed in/);
      assert.doesNotMatch(t.dom.root.textContent, /Sign in to Codex/);
      assert.equal(startButton(t.dom).getAttribute("aria-disabled"), "true");
    } finally { t.teardown(); }
  });
});

function textarea(dom: Dom): FakeElement {
  const found = dom.all().find((node) => node.tagName === "TEXTAREA");
  assert.ok(found, "the task box is on the page");
  return found;
}

function startButton(dom: Dom): FakeElement {
  const row = dom.findAll(".taskbox-actions")[0];
  assert.ok(row, "the box has an action row");
  const button = row.children.filter((child) => !child.hidden).at(-1);
  assert.ok(button, "the box has a start button");
  return button;
}

async function mount(server: Server, options: { hash?: string; pill?: boolean } = {}) {
  resetSession();
  const dom = installDom(options);
  if (options.pill) {
    const pill = dom.document.createElement("button");
    pill.id = "tb-pill";
    for (const cls of ["dot", "label", "sub"]) {
      const span = dom.document.createElement("span");
      span.className = cls;
      pill.append(span);
    }
    dom.document.body.append(pill);
  }
  const restoreFetch = serve(server);
  const view = createHomeView({ activeMs: 2, hiddenMs: 4 });
  view.mount(dom.root as unknown as HTMLElement);
  await settle(8);
  return {
    dom,
    view,
    teardown() {
      view.unmount();
      restoreFetch();
      dom.restore();
    },
  };
}

/* -------------------------------------------------------------------------
 * Pure copy and state
 * ---------------------------------------------------------------------- */

describe("home — the words on the screen", () => {
  it("names task outcomes and current control without guessing the holder", () => {
    assert.deepEqual(recentStatus("running"), { word: "Working", tone: "run" });
    assert.deepEqual(recentStatus("pending_approval"), { word: "Waiting for you", tone: "warn" });
    assert.deepEqual(recentStatus("takeover_requested"), { word: "Waiting for you", tone: "warn" });
    assert.deepEqual(recentStatus("paused"), { word: "Waiting for you", tone: "warn" });
    assert.deepEqual(recentStatus("completed"), { word: "Done", tone: "ok" });
    assert.deepEqual(recentStatus("cancelled"), { word: "You stopped it", tone: "neutral" });
    assert.deepEqual(recentStatus("failed"), { word: "Couldn’t finish", tone: "danger" });
    assert.deepEqual(recentStatus("running", "human"), { word: "Human control", tone: "warn" });
    assert.deepEqual(recentStatus("running", "paused"), { word: "Control paused", tone: "warn" });
    assert.deepEqual(recentStatus("running", "resume_validating"), { word: "Returning control", tone: "run" });
    assert.deepEqual(recentStatus("running", "takeover_requested"), { word: "Waiting for you", tone: "warn" });
    assert.deepEqual(recentStatus("completed", "human"), { word: "Done", tone: "ok" });
  });

  it("carries no jargon anywhere a person can read it", () => {
    const banned =
      /\b(daemon|bootstrap|CSRF|token|computer_id|takeover epoch|container|sidecar|sandbox|workspace)\b/i;
    const strings = [
      EMPTY_RECENT,
      ...EXAMPLES,
      ...[DOCKER_MISSING, NO_AI].flatMap((status) => {
        const card = blockerCard(status)!;
        return [
          card.heading,
          card.body,
          card.watch.text,
          card.detail?.text ?? "",
          ...card.actions.map((a) => a.label),
        ];
      }),
    ];
    for (const text of strings) assert.doesNotMatch(text, banned, text);
  });

  it("never says anything claim-scan bans", () => {
    const banned = /\b(unlimited|any subscription|already pay for|any model or subscription)\b/i;
    const card = blockerCard(NO_AI)!;
    for (const text of [card.heading, card.body, EMPTY_RECENT]) {
      assert.doesNotMatch(text, banned, text);
    }
  });

  it("says the shortest true thing about when a task ran", () => {
    const now = new Date("2026-09-07T12:00:00Z").getTime();
    assert.equal(relativeTime("2026-09-07T11:58:00Z", now), "2 min");
    assert.equal(relativeTime("2026-09-07T11:59:50Z", now), "just now");
    assert.equal(relativeTime("2026-09-07T09:00:00Z", now), "3 hr");
    assert.equal(relativeTime("not a date", now), "");
  });
});

describe("home — what the blocker card says", () => {
  it("asks for the AI before it asks for Docker", () => {
    const both = runtime({
      task_start_available: false,
      blockers: [...DOCKER_MISSING.blockers, ...NO_AI.blockers],
      ai: NO_AI.ai,
    });
    assert.equal(blockerCard(both)?.key, "ai_not_connected");
  });

  it("names the engine the person actually installed", () => {
    const stopped = runtime({
      task_start_available: false,
      docker: { installed: true, running: false, engine: "docker-desktop", version: "4" },
      blockers: [{ id: "docker_not_running", title: "", detail: "", action: { kind: "retry" } }],
    });
    const card = blockerCard(stopped)!;
    assert.equal(card.heading, "Docker Desktop isn’t running yet");
    assert.equal(card.actions[0]?.label, "Open Docker Desktop");
  });

  it("turns a running build into a meter, not a spinner", () => {
    const preparing = runtime({ task_start_available: false });
    preparing.images.prepare = {
      state: "running",
      step: "Building the browser workspace (1 of 3)",
      percent: 33,
      log_tail: [],
      error: null,
    };
    const card = blockerCard(preparing)!;
    assert.equal(card.key, "preparing");
    assert.equal(card.progress?.percent, 33);
    assert.equal(card.actions.length, 0, "a build in progress asks for nothing");
  });

  it("offers a way back when the one-time setup fails", () => {
    const failed = runtime({ task_start_available: false });
    failed.images.prepare = {
      state: "failed",
      step: "",
      percent: null,
      log_tail: [],
      error: "docker build exited 1; see the log",
    };
    const card = blockerCard(failed)!;
    assert.equal(card.actions[0]?.label, "Try again");
    assert.equal(card.detail?.text, "docker build exited 1; see the log");
  });

  it("has nothing to say once the machine is ready", () => {
    assert.equal(blockerCard(runtime()), null);
  });
});

describe("home — the start button always states its reason", () => {
  it("is ready and keyboard-first when nothing is in the way", () => {
    const state = composerState({
      ready: true,
      blockerKey: null,
      hasText: true,
      armed: false,
      submitting: false,
    });
    assert.equal(state.label, "Start task");
    assert.equal(state.disabled, false);
    assert.equal(state.keys, true);
  });

  it("waits, rather than refusing, while the computer is still coming up", () => {
    const state = composerState({
      ready: false,
      blockerKey: "docker_missing",
      hasText: true,
      armed: false,
      submitting: false,
    });
    assert.equal(state.label, "Start when ready");
    assert.equal(state.disabled, true);
    assert.equal(state.hint, "Write it now — it starts the moment the computer is ready");
  });

  it("points at the AI card when that is what is missing", () => {
    const state = composerState({
      ready: false,
      blockerKey: "ai_not_connected",
      hasText: true,
      armed: false,
      submitting: false,
    });
      assert.equal(state.hint, "Connect a model above to start");
  });

  it("offers a way out of a queued start", () => {
    const state = composerState({
      ready: false,
      blockerKey: "docker_missing",
      hasText: true,
      armed: true,
      submitting: false,
    });
    assert.equal(state.cancel, true);
    assert.match(state.hint, /^Queued/);
  });
});

/* -------------------------------------------------------------------------
 * The mounted view
 * ---------------------------------------------------------------------- */

describe("home — on arrival", () => {
  it("lands the caret in the task box with the draft already in it", async () => {
    const dom = installDom();
    dom.storage.set("modelbot.draft", "Find last month’s invoice");
    const restoreFetch = serve({ runtime: runtime(), tasks: [], posts: [] });
    const view = createHomeView({ activeMs: 2 });
    try {
      view.mount(dom.root as unknown as HTMLElement);
      await settle(8);
      const box = textarea(dom);
      assert.equal(dom.document.activeElement, box, "the caret is in the box, with no click");
      assert.equal(box.value, "Find last month’s invoice");
      assert.equal(box.selectionStart, box.value.length, "and at the end of what was typed");
    } finally {
      view.unmount();
      restoreFetch();
      dom.restore();
    }
  });

  it("shows one h1, one label for the box, and the three examples", async () => {
    const m = await mount({ runtime: runtime(), tasks: [], posts: [] });
    try {
      const headings = m.dom.all().filter((node) => node.tagName === "H1");
      assert.equal(headings.length, 1, "exactly one h1 per view (ux-spec §7)");
      assert.match(headings[0]!.textContent, /^What should your botget done\?$/);

      const label = m.dom.all().find((node) => node.tagName === "LABEL");
      assert.ok(label, "the box has a real label, not just a placeholder");
      assert.equal(label.getAttribute("for"), "home-goal");
      assert.equal(label.hidden, false, "…and it is available to a screen reader");

      const examples = m.dom.findAll(".example");
      assert.equal(examples.length, 3);
      assert.equal(examples[0]!.textContent, EXAMPLES[0]);
    } finally {
      m.teardown();
    }
  });

  it("fills the box from an example and puts the caret back", async () => {
    const m = await mount({ runtime: runtime(), tasks: [], posts: [] });
    try {
      m.dom.findAll(".example")[1]!.click();
      const box = textarea(m.dom);
      assert.equal(box.value, EXAMPLES[1]);
      assert.equal(m.dom.document.activeElement, box);
      assert.equal(m.dom.storage.get("modelbot.draft"), EXAMPLES[1]);
    } finally {
      m.teardown();
    }
  });
});

describe("home — starting a task", () => {
  it("requires a real link for a starter and preserves a draft while choosing one", async () => {
    const server: Server = { runtime: runtime(), tasks: [], posts: [] };
    const m = await mount(server);
    try {
      const box = textarea(m.dom);
      box.value = "Focus on customers who run a small business.";
      m.dom.findAll(".example")[0]!.click();
      assert.match(box.value, /^Focus on customers/);
      assert.equal(box.value.slice(box.selectionStart, box.selectionEnd), "[website URL]");
      startButton(m.dom).click();
      await settle();
      assert.equal(server.posts.length, 0);
      assert.match(m.dom.find(".taskbox-message")!.textContent, /Replace the selected placeholder/);
      box.value = box.value.replace("[website URL]", "not-a-link");
      startButton(m.dom).click();
      await settle();
      assert.equal(server.posts.length, 0);
      assert.match(m.dom.find(".taskbox-message")!.textContent, /https:\/\//);
      box.value = box.value.replace("not-a-link", "https://example.org");
      startButton(m.dom).click();
      await settle();
      assert.equal(server.posts.length, 1);
      assert.match(JSON.stringify(server.posts[0]!.body), /https:\/\/example.org/);
    } finally { m.teardown(); }
  });

  it("posts exactly once on ⌘↩ and goes to the new task", async () => {
    const server: Server = { runtime: runtime(), tasks: [], posts: [] };
    const m = await mount(server);
    try {
      const box = textarea(m.dom);
      box.value = "Book a table for four";
      box.fire("input");

      box.fire("keydown", { key: "Enter", metaKey: true });
      box.fire("keydown", { key: "Enter", metaKey: true });
      await settle(8);

      assert.equal(server.posts.length, 1, "a second ⌘↩ while in flight must not start a twin");
      assert.deepEqual(
        server.posts[0]!.body,
        { goal: "Book a table for four", capabilities: ["browser"] },
        "the step limit belongs to the daemon's config, not to this screen",
      );
      assert.equal(location.hash, "#/tasks/task_new");
      assert.equal(m.dom.storage.get("modelbot.draft"), undefined, "the draft is spent");
    } finally {
      m.teardown();
    }
  });

  it("treats a bare Return as a newline, never as a start", async () => {
    const server: Server = { runtime: runtime(), tasks: [], posts: [] };
    const m = await mount(server);
    try {
      const box = textarea(m.dom);
      box.value = "Line one";
      box.fire("input");
      box.fire("keydown", { key: "Enter" });
      box.fire("keydown", { key: "Enter", shiftKey: true });
      await settle(4);
      assert.equal(server.posts.length, 0);
    } finally {
      m.teardown();
    }
  });

  it("keeps the draft and names the open task when one is already running", async () => {
    const server: Server = { runtime: runtime(), tasks: [], posts: [] };
    const m = await mount(server);
    try {
      const saved = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/v1/tasks" && (init?.method ?? "GET") === "POST") {
          return Response.json(
            {
              error: "E_TASK_ACTIVE",
              message: "Your current task is still working. Open it to continue or stop it before starting another.",
              task_id: "task_old",
            },
            { status: 409 },
          );
        }
        return saved(input, init);
      }) as typeof fetch;

      const box = textarea(m.dom);
      box.value = "Something else";
      box.fire("input");
      box.fire("keydown", { key: "Enter", metaKey: true });
      await settle(8);

      const message = m.dom.find(".taskbox-message")!;
      assert.match(message.textContent, /still working/);
      assert.equal(message.querySelector("a")?.getAttribute("href"), "#/tasks/task_old");
      assert.equal(box.value, "Something else", "the draft is never thrown away on an error");
      globalThis.fetch = saved;
    } finally {
      m.teardown();
    }
  });
});

describe("home — a blocker never takes the box away", () => {
  it("shows the card above a box that still accepts text", async () => {
    const m = await mount({ runtime: DOCKER_MISSING, tasks: [], posts: [] });
    try {
      const card = m.dom.find(".blocker");
      assert.ok(card, "the blocker card is on the page");
      assert.match(card.textContent, /Install Docker to continue/);

      const box = textarea(m.dom);
      assert.ok(box, "the task box is still here");
      assert.equal(box.disabled, false, "and still typeable");
      box.value = "I can write this while Docker installs";
      box.fire("input");
      assert.equal(m.dom.storage.get("modelbot.draft"), "I can write this while Docker installs");

      const start = startButton(m.dom);
      assert.equal(start.textContent, "Start when ready");
      assert.equal(start.getAttribute("aria-disabled"), "true");
      // A disabled control is dimmed by a token pair, never by opacity.
      assert.doesNotMatch(start.className, /opacity/);
    } finally {
      m.teardown();
    }
  });

  it("expands the 'why' in place instead of opening a modal", async () => {
    const m = await mount({ runtime: DOCKER_MISSING, tasks: [], posts: [] });
    try {
      const why = m.dom.findAll(".blocker-actions .btn").find((b) => b.textContent === "Why is this needed?");
      assert.ok(why);
      const detail = m.dom.find(".blocker-detail")!;
      assert.equal(detail.hidden, true);
      assert.equal(why.getAttribute("aria-expanded"), "false");
      why.click();
      assert.equal(detail.hidden, false);
      assert.equal(why.getAttribute("aria-expanded"), "true");
      assert.equal(m.dom.findAll(".scrim").length, 0, "nothing became a modal");
    } finally {
      m.teardown();
    }
  });

  it("links straight out to both installers", async () => {
    const m = await mount({ runtime: DOCKER_MISSING, tasks: [], posts: [] });
    try {
      const links = m.dom.findAll(".blocker-actions a");
      assert.equal(links[0]!.textContent, "Install OrbStack");
      assert.equal(links[0]!.getAttribute("href"), "https://orbstack.dev/download");
      assert.equal(links[1]!.textContent, "Use Docker Desktop");
      for (const link of links) assert.equal(link.getAttribute("rel"), "noopener noreferrer");
    } finally {
      m.teardown();
    }
  });

  it("sends the AI card to the AI section of Settings", async () => {
    const m = await mount({ runtime: NO_AI, tasks: [], posts: [] });
    try {
      const card = m.dom.find(".blocker")!;
      assert.match(card.textContent, /Connect your model account/);
      const use = m.dom.findAll(".blocker-actions .btn").find((b) => b.textContent === "Use Claude")!;
      use.click();
      assert.match(location.hash, /^#\/settings\/ai/);
    } finally {
      m.teardown();
    }
  });
});

describe("home — readiness advances on its own", () => {
  it("drops the card and enables the button with no click", async () => {
    const server: Server = { runtime: DOCKER_MISSING, tasks: [], posts: [] };
    const m = await mount(server);
    try {
      assert.ok(m.dom.find(".blocker"), "blocked to begin with");
      assert.equal(startButton(m.dom).textContent, "Start when ready");

      // Docker came up. Nothing on screen is touched.
      server.runtime = runtime();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await settle(8);

      const card = m.dom.find(".blocker");
      assert.ok(!card || card.classList.contains("is-leaving"), "the card is on its way out");
      assert.equal(startButton(m.dom).textContent, "Start task");
      assert.equal(startButton(m.dom).getAttribute("aria-disabled"), "true", "…and waits for text");
    } finally {
      m.teardown();
    }
  });

  it("starts a queued task the moment the computer is ready", async () => {
    const server: Server = { runtime: DOCKER_MISSING, tasks: [], posts: [] };
    const m = await mount(server);
    try {
      const box = textarea(m.dom);
      box.value = "Start this as soon as you can";
      box.fire("input");
      box.fire("keydown", { key: "Enter", metaKey: true });
      await settle(4);

      assert.equal(server.posts.length, 0, "nothing is posted while the computer is missing");
      assert.equal(startButton(m.dom).textContent, "Waiting to start");

      server.runtime = runtime();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await settle(8);

      assert.equal(server.posts.length, 1, "the queued task fires by itself (ux-spec §1)");
      assert.equal((server.posts[0]!.body as { goal: string }).goal, "Start this as soon as you can");
    } finally {
      m.teardown();
    }
  });

  it("lets a queued start be taken back", async () => {
    const server: Server = { runtime: DOCKER_MISSING, tasks: [], posts: [] };
    const m = await mount(server);
    try {
      const box = textarea(m.dom);
      box.value = "Actually, not yet";
      box.fire("input");
      box.fire("keydown", { key: "Enter", metaKey: true });
      await settle(4);

      const cancel = m.dom.findAll(".taskbox-actions .btn").find((b) => b.textContent === "Cancel")!;
      assert.equal(cancel.hidden, false);
      cancel.click();

      server.runtime = runtime();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await settle(8);
      assert.equal(server.posts.length, 0, "a cancelled queue never fires");
    } finally {
      m.teardown();
    }
  });
});

describe("home — Recent", () => {
  const tasks = [
    { id: "t1", goal: "Find the 3 cheapest direct flights", status: "running", created_at: new Date(Date.now() - 120_000).toISOString(), computer_id: "c", max_steps: 60 },
    { id: "t2", goal: "Summarise the four PDFs", status: "completed", created_at: new Date(Date.now() - 86_400_000).toISOString(), computer_id: "c", max_steps: 60 },
    { id: "t3", goal: "Check every link", status: "failed", created_at: new Date(Date.now() - 3 * 86_400_000).toISOString(), computer_id: "c", max_steps: 60 },
    { id: "t4", goal: "Renew the domain", status: "cancelled", created_at: new Date(Date.now() - 4 * 86_400_000).toISOString(), computer_id: "c", max_steps: 60 },
    { id: "t5", goal: "An older one", status: "completed", created_at: new Date(Date.now() - 9 * 86_400_000).toISOString(), computer_id: "c", max_steps: 60 },
  ];

  it("shows four rows, a word per status, and the way to the rest", async () => {
    const m = await mount({ runtime: runtime(), tasks, posts: [] });
    try {
      const rows = m.dom.findAll(".recent-row");
      assert.equal(rows.length, 4, "Recent is a glance, not a list view");
      assert.match(rows[0]!.textContent, /Working · 2 min/);
      assert.match(rows[1]!.textContent, /Done · yesterday/);
      assert.match(rows[2]!.textContent, /Couldn’t finish/);
      assert.match(rows[3]!.textContent, /You stopped it/);
      assert.equal(rows[0]!.getAttribute("href"), "#/tasks/t1");

      const all = m.dom.find(".recent-all")!;
      assert.match(all.textContent, /^All 5 tasks/);
      assert.equal(all.getAttribute("href"), "#/tasks");
    } finally {
      m.teardown();
    }
  });

  it("teaches rather than shrugs when there is nothing yet", async () => {
    const m = await mount({ runtime: runtime(), tasks: [], posts: [] });
    try {
      assert.equal(m.dom.find(".recent-empty")?.textContent, EMPTY_RECENT);
      assert.equal(m.dom.findAll(".recent-row").length, 0);
    } finally {
      m.teardown();
    }
  });

  it("loads and refreshes human control without treating an old task's control as this task's", async () => {
    const server: Server = {
      runtime: runtime(), tasks, posts: [],
      takeovers: [
        { id: "old", task_id: "old_task", computer_id: "c", state: "human" },
        { id: "tk1", task_id: "t1", computer_id: "c", state: "human" },
      ],
    };
    const m = await mount(server);
    try {
      assert.match(m.dom.findAll(".recent-row")[0]!.textContent, /Human control/);
      assert.match(m.dom.findAll(".recent-row")[1]!.textContent, /Done/);
      for (const [state, expected] of [["paused", "Control paused"], ["resume_validating", "Returning control"], ["agent", "Working"]]) {
        server.takeovers![1]!.state = state;
        attention.sync([]);
        await settle(8);
        assert.ok(m.dom.findAll(".recent-row")[0]!.textContent.includes(expected!), `state ${state}`);
      }
    } finally {
      m.teardown();
    }
  });

  it("keeps recent tasks readable without claiming the bot is working when control cannot be read", async () => {
    const m = await mount({ runtime: runtime(), tasks, posts: [], failTakeovers: true });
    try {
      assert.match(m.dom.findAll(".recent-row")[0]!.textContent, /Active · 2 min/);
      assert.match(m.dom.findAll(".recent-row")[1]!.textContent, /Done/);
    } finally {
      m.teardown();
    }
  });
});

describe("home — when ModelBot goes away", () => {
  it("replaces the card with a recovery, keeps the draft, and never blames the person", async () => {
    const server: Server = { runtime: runtime(), tasks: [], posts: [], fail: "network" };
    const m = await mount(server);
    try {
      const box = textarea(m.dom);
      box.value = "Still mine";
      box.fire("input");

      // Two failures in a row, not one blip.
      await new Promise((resolve) => setTimeout(resolve, 40));
      await settle(8);

      const card = m.dom.find(".blocker-offline");
      assert.ok(card, "the recovery card is up");
      assert.match(card.textContent, /BotHearth stopped unexpectedly\./);
      assert.match(card.textContent, /Your draft is saved/);
      assert.doesNotMatch(card.textContent, /you (broke|did)/i);
      assert.ok(m.dom.findAll(".blocker-offline .btn").some((b) => b.textContent === "Try again"));
      assert.ok(
        m.dom.findAll(".blocker-offline .btn").some((b) => b.textContent === "Copy diagnostics"),
      );
      assert.equal(textarea(m.dom).value, "Still mine", "the draft outlives the outage");
    } finally {
      m.teardown();
    }
  });
});

describe("home — the draft outlives everything", () => {
  it("survives a trip to Settings and a reload", async () => {
    const dom = installDom();
    const restoreFetch = serve({ runtime: runtime(), tasks: [], posts: [] });
    try {
      const first = createHomeView({ activeMs: 2 });
      first.mount(dom.root as unknown as HTMLElement);
      await settle(8);
      const box = textarea(dom);
      box.value = "Half a sentence I am still writing";
      box.fire("input");

      // Off to Settings and back — the view is torn down and rebuilt.
      first.unmount();
      dom.root.replaceChildren();
      const second = createHomeView({ activeMs: 2 });
      second.mount(dom.root as unknown as HTMLElement);
      await settle(8);
      assert.equal(textarea(dom).value, "Half a sentence I am still writing");
      second.unmount();

      // A reload is a fresh module against the same storage.
      dom.root.replaceChildren();
      const third = createHomeView({ activeMs: 2 });
      third.mount(dom.root as unknown as HTMLElement);
      await settle(8);
      assert.equal(textarea(dom).value, "Half a sentence I am still writing");
      third.unmount();
    } finally {
      restoreFetch();
      dom.restore();
    }
  });
});

describe("home — a start needs the whole ladder, not just the AI", () => {
  it("stays disabled while Docker is missing, even with the AI connected", async () => {
    // task_start_available speaks for the AI alone; the container is separate.
    const aiReadyDockerGone = runtime({
      task_start_available: true,
      docker: { installed: false, running: false, engine: "unknown", version: "" },
      blockers: DOCKER_MISSING.blockers,
    });
    const server: Server = { runtime: aiReadyDockerGone, tasks: [], posts: [] };
    const m = await mount(server);
    try {
      const box = textarea(m.dom);
      box.value = "Should not fire yet";
      box.fire("input");
      box.fire("keydown", { key: "Enter", metaKey: true });
      await settle(6);
      assert.equal(server.posts.length, 0, "no task is started into a computer that is not there");
      assert.equal(startButton(m.dom).textContent, "Waiting to start");
    } finally {
      m.teardown();
    }
  });
});
