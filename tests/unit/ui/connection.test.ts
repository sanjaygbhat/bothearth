import assert from "node:assert/strict";
import { test } from "node:test";
import {
  lastCheckedLabel,
  limitWord,
  providerRowCopy,
  statusTone,
  statusWord,
} from "../../../src/ui/connection.ts";
import { limitTime } from "../../../src/ui/runtime.ts";
import { all, byText, installDom, settle, type FakeElement } from "./fake-dom.ts";

const json = (body: unknown) => Response.json(body as Record<string, unknown>);

type Scenario = {
  connection: (provider: string) => Record<string, unknown>;
  runtime?: Record<string, unknown>;
  posts: string[];
  onPost?: (path: string, body: Record<string, unknown>) => Record<string, unknown> | undefined;
};

async function mountAi(scenario: Scenario) {
  const dom = installDom({ timers: "manual", hash: "#/settings", fetch: async (path, init) => {
    if (init?.method === "POST") {
      scenario.posts.push(path);
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const reply = scenario.onPost?.(path, body);
      return json(reply ?? { status: "connected", provider: "claude", model: "opus-4.5" });
    }
    if (path.startsWith("/api/v1/runtime")) {
      return json(
        scenario.runtime ?? {
          ai: { provider: "claude", cli_found: true, cli_path_kind: "path", logged_in: false, detail: "" },
        },
      );
    }
    const asked = /provider=(\w+)/.exec(path)?.[1] ?? "";
    return json(scenario.connection(asked));
  } });
  const module = await import(`../../../src/ui/connection.ts?case=${Math.random()}`);
  const pane = dom.document.createElement("div");
  dom.document.body.append(pane);
  const dispose = module.renderAiConnection(pane);
  await settle();
  await settle();
  return { dom, pane, dispose };
}

const actionButton = (pane: FakeElement) =>
  all(pane).find((node) => node.className === "btn primary") as FakeElement;

test("plain-English copy is what a row says; identifiers stay behind Details", () => {
  assert.equal(
    providerRowCopy("claude", { status: "connected", provider: "claude", model: "Opus 4.5" }, true),
    "Signed in as you · Opus 4.5 · billed on your Claude plan",
  );
  assert.equal(
    providerRowCopy("codex", { status: "signed_out", provider: "codex", model: "" }, true),
    "Found on this Mac · not signed in",
  );
  assert.equal(
    providerRowCopy("codex", { status: "missing", provider: "codex", model: "" }, false),
    "Not on this Mac yet",
  );
  assert.equal(providerRowCopy("claude", null, true), "Found on this Mac");
  assert.equal(lastCheckedLabel(1_000), "a moment ago");
  assert.equal(lastCheckedLabel(120_000), "2 minutes ago");
  assert.equal(lastCheckedLabel(3 * 3_600_000), "3 hours ago");
  assert.equal(statusWord("connected"), "Connected");
  assert.equal(statusTone("connected"), "ok");
  assert.equal(statusTone("error"), "danger");
});

test("a signed-in provider that is refusing does not read Connected", () => {
  const spent = { reason: "quota_exhausted", resets_at: "2026-09-11T17:21:00.000Z" } as const;
  const until = limitTime(spent.resets_at);
  // `codex login status` exits 0 on a dry plan, so `status` stays "connected".
  assert.equal(statusWord("connected", spent), `Plan limit reached until ${until}`);
  assert.equal(statusTone("connected", spent), "warn");
  assert.equal(statusWord("connected", { reason: "rate_limited", resets_at: null }), "Turning tasks down");
  assert.equal(
    providerRowCopy("codex", { status: "connected", provider: "codex", model: "GPT-6 Astra", limit: spent }, true),
    `Signed in as you · GPT-6 Astra · Plan limit reached until ${until}`,
  );
  // No limit, no change.
  assert.equal(statusWord("connected", null), "Connected");
  assert.equal(limitWord(null), null);
});

test("Settings shows the limit instead of Connected, and the chip agrees", async () => {
  const spent = { reason: "quota_exhausted", resets_at: "2026-09-11T17:21:00.000Z" };
  const scenario: Scenario = {
    posts: [],
    connection: () => ({ status: "connected", provider: "codex", model: "gpt-6-astra", limit: spent }),
    runtime: {
      ai: {
        provider: "codex",
        cli_found: true,
        cli_path_kind: "path",
        logged_in: true,
        detail: "",
        limit: spent,
      },
    },
  };
  const dom = installDom({ timers: "manual", hash: "#/settings", fetch: async (path) => {
    if (path.startsWith("/api/v1/runtime")) return json(scenario.runtime);
    return json(scenario.connection(""));
  } });
  try {
    const pill = dom.document.createElement("button");
    pill.id = "tb-pill";
    for (const cls of ["dot", "label", "sub"]) {
      const span = dom.document.createElement("span");
      span.className = cls;
      pill.append(span);
    }
    dom.document.body.append(pill);

    const module = await import(`../../../src/ui/connection.ts?limit=${Math.random()}`);
    const pane = dom.document.createElement("div");
    dom.document.body.append(pane);
    const dispose = module.renderAiConnection(pane);
    await settle();
    await settle();

    const until = limitTime(spent.resets_at);
    const text = all(pane).map((n) => n.textContent).join(" ");
    assert.match(text, new RegExp(`Plan limit reached until ${until}`));
    assert.doesNotMatch(text, /\bConnected\b/);
    assert.equal(pill.querySelector(".sub")!.textContent, `· plan limit reached until ${until}`);
    dispose();
  } finally {
    dom.restore();
  }
});

test("opening Settings never signs in; one click signs in, polls, then connects exactly once", async () => {
  let status = "signed_out";
  const scenario: Scenario = {
    posts: [],
    connection: () => ({ status, provider: "codex", model: "gpt-6-astra" }),
    onPost(path) {
      if (path.endsWith("sign-in")) {
        status = "signing_in";
        return { status, provider: "codex", model: "gpt-6-astra" };
      }
      if (path.endsWith("connect")) {
        status = "connected";
        return { status: "connected", provider: "codex", model: "gpt-6-astra" };
      }
      return undefined;
    },
  };
  const { dom, pane, dispose } = await mountAi(scenario);
  try {
    assert.deepEqual(scenario.posts, [], "arriving in Settings posts nothing at all");
    const action = actionButton(pane);
    assert.equal(action.textContent, "Sign in with ChatGPT");

    action.fire("click");
    action.fire("click");
    await settle();
    await settle();
    assert.deepEqual(scenario.posts, ["/api/v1/connection/sign-in"], "a double click still signs in once");

    // The CLI finishes in its own browser; the poll notices and connects.
    status = "signed_in";
    dom.runTimers();
    await settle();
    await settle();
    await settle();
    assert.deepEqual(scenario.posts, ["/api/v1/connection/sign-in", "/api/v1/connection/connect"]);
    assert.match(all(pane).map((n) => n.textContent).join(" "), /Connected/);

    // Nothing further happens on its own once connected.
    const before = scenario.posts.length;
    dom.runTimers();
    await settle();
    assert.equal(scenario.posts.length, before);
  } finally {
    dispose();
    dom.restore();
  }
});

test("a sign-in that lives in a terminal only offers Check again, and posts nothing", async () => {
  const scenario: Scenario = {
    posts: [],
    connection: () => ({
      status: "signed_out",
      provider: "claude",
      model: "",
      login_mode: "terminal",
      message: "Sign in to Claude Code on this machine, then check again.",
    }),
  };
  const { dom, pane, dispose } = await mountAi(scenario);
  try {
    const action = actionButton(pane);
    assert.equal(action.textContent, "Check again");
    action.fire("click");
    await settle();
    await settle();
    assert.deepEqual(scenario.posts, [], "a remote sign-in is never started from here");
    assert.equal(byText(pane, "Check again") !== undefined, true);
  } finally {
    dispose();
    dom.restore();
  }
});

test("the Codex one-time code is shown only for the official page, and is cleared on the way out", async () => {
  let challenge: Record<string, unknown> = {
    verification_uri: "https://auth.openai.com/codex/device",
    user_code: "ABCD-12345",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const scenario: Scenario = {
    posts: [],
    connection: () => ({
      status: "signing_in",
      provider: "codex",
      model: "gpt-6-astra",
      login_mode: "device",
      device_auth: challenge,
    }),
  };
  const { dom, pane, dispose } = await mountAi(scenario);
  try {
    const panel = all(pane).find((n) => n.className.includes("set-device")) as FakeElement;
    assert.equal(panel.hidden, false);
    assert.equal(panel.children[0]?.href, "https://auth.openai.com/codex/device");
    assert.match(panel.textContent, /ABCD-12345/);

    challenge = { ...challenge, verification_uri: "https://attacker.invalid" };
    dom.runTimers();
    await settle();
    await settle();
    assert.equal(panel.hidden, true, "an unofficial verification page is never linked");
    assert.doesNotMatch(panel.textContent, /ABCD/);

    challenge = {
      verification_uri: "https://auth.openai.com/codex/device",
      user_code: "ABCD-12345",
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    };
    dom.runTimers();
    await settle();
    await settle();
    assert.equal(panel.hidden, true, "an expired challenge is not shown either");
    assert.deepEqual(scenario.posts, []);
  } finally {
    dispose();
    dom.restore();
  }
});

test("a task in flight refuses the change in words, not in a status code", async () => {
  const scenario: Scenario = {
    posts: [],
    connection: () => ({ status: "signed_in", provider: "claude", model: "" }),
  };
  const dom = installDom({ timers: "manual", hash: "#/settings", fetch: async (path, init) => {
    if (init?.method === "POST") {
      scenario.posts.push(path);
      return Response.json({ error: "E_TASK_ACTIVE", message: "nope" }, { status: 409 });
    }
    if (path.startsWith("/api/v1/runtime")) return json({ ai: { provider: "claude", cli_found: true, cli_path_kind: "path", logged_in: true, detail: "" } });
    return json(scenario.connection(""));
  } });
  try {
    const module = await import(`../../../src/ui/connection.ts?busy=${Math.random()}`);
    const pane = dom.document.createElement("div");
    dom.document.body.append(pane);
    const dispose = module.renderAiConnection(pane);
    await settle();
    await settle();
    actionButton(pane).fire("click");
    await settle();
    await settle();
    assert.match(
      all(pane).map((n) => n.textContent).join(" "),
      /Finish or stop your current task before changing the AI connection\./,
    );
    dispose();
  } finally {
    dom.restore();
  }
});

test("both providers are shown honestly, and choosing one re-asks for that one", async () => {
  const asked: string[] = [];
  const scenario: Scenario = {
    posts: [],
    connection: (provider) => {
      asked.push(provider);
      return provider === "codex"
        ? { status: "missing", provider: "codex", model: "", install_url: "https://example.invalid/codex" }
        : { status: "connected", provider: "claude", model: "Opus 4.5" };
    },
  };
  const { dom, pane, dispose } = await mountAi(scenario);
  try {
    const rows = all(pane).filter((n) => n.className === "set-opt");
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.getAttribute("aria-checked"), "true");
    assert.match(rows[0]?.textContent ?? "", /Claude Code/);
    assert.match(rows[1]?.textContent ?? "", /Codex/);
    assert.match(rows[1]?.textContent ?? "", /Not on this Mac yet/, "the other row is probed too");

    (rows[1] as FakeElement).fire("click");
    await settle();
    await settle();
    assert.ok(asked.includes("codex"), "picking Codex asks the daemon about Codex");
    assert.equal(rows[1]?.getAttribute("aria-checked"), "true");
    assert.deepEqual(scenario.posts, [], "choosing a provider is not a sign-in");
  } finally {
    dispose();
    dom.restore();
  }
});

test("switching the AI updates the titlebar chip without a reload", async () => {
  const scenario: Scenario = {
    posts: [],
    connection: () => ({ status: "signed_in", provider: "claude", model: "" }),
    onPost: () => ({ status: "connected", provider: "claude", model: "claude-opus-5" }),
  };
  const { dom, pane, dispose } = await mountAi(scenario);
  try {
    // The titlebar the shell owns. Without it `setStatusPill` is a no-op, and
    // the chip read "Codex · GPT-6 Astra" for a whole session that ran on Claude.
    const pill = dom.document.createElement("button");
    pill.id = "tb-pill";
    for (const cls of ["dot", "label", "sub"]) {
      const span = dom.document.createElement("span");
      span.className = cls;
      pill.append(span);
    }
    dom.document.body.append(pill);

    actionButton(pane).fire("click");
    await settle();
    await settle();

    assert.ok(scenario.posts.some((path) => path.endsWith("/connection/connect")));
    assert.equal(pill.querySelector(".label")!.textContent, "Claude · Opus 5");
    assert.match(pill.getAttribute("aria-label") ?? "", /AI connection: Claude · Opus 5/);
  } finally {
    dispose();
    dom.restore();
  }
});
