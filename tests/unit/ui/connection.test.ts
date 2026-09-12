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
  onPost?: (path: string, body: Record<string, unknown>) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
};

async function mountAi(scenario: Scenario) {
  const dom = installDom({ timers: "manual", hash: "#/settings", fetch: async (path, init) => {
    if (init?.method === "POST") {
      scenario.posts.push(path);
      const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const reply = await scenario.onPost?.(path, body);
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
    "Found · not signed in",
  );
  assert.equal(
    providerRowCopy("codex", { status: "missing", provider: "codex", model: "" }, false),
    "Not installed yet",
  );
  assert.equal(providerRowCopy("claude", null, true), "Found");
  assert.equal(providerRowCopy("claude", { status: "signed_out", provider: "claude", model: "",
    execution_location: "computer" }, true), "In the bot’s computer · not signed in");
  assert.equal(providerRowCopy("codex", { status: "unknown", provider: "codex", model: "gpt-6-astra",
    execution_location: "computer" }, true), "Can’t check while you have control");
  assert.equal(statusWord("unknown"), "Can’t check while you have control");
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

test("a hold that blocks the connection check is not a sign-out and is rechecked", async () => {
  let status = "unknown";
  const scenario: Scenario = {
    posts: [],
    connection: () => ({
      status, provider: "codex", model: "gpt-6-astra", login_mode: "device",
      execution_location: "computer", message: status === "unknown" ? "Can’t check while you have control" : "",
    }),
  };
  const { pane, dispose, dom } = await mountAi(scenario);
  try {
    assert.match(pane.textContent, /Can’t check while you have control/);
    assert.doesNotMatch(pane.textContent, /not signed in|Sign in with ChatGPT/);
    assert.equal(actionButton(pane).textContent, "Check again");
    status = "connected";
    dom.runTimers();
    await settle();
    await settle();
    assert.match(pane.querySelector(".set-state")?.textContent ?? pane.textContent, /Connected/);
    assert.notEqual(actionButton(pane).textContent, "Check again");
  } finally { dispose(); dom.restore(); }
});

test("an empty error message still tells the person to check again", async () => {
  const scenario: Scenario = {
    posts: [],
    connection: () => ({ status: "error", provider: "codex", model: "", message: "" }),
  };
  const { pane, dispose, dom } = await mountAi(scenario);
  try {
    const msg = pane.querySelector(".set-msg")!;
    assert.ok(msg.textContent.length > 0);
    assert.match(msg.textContent, /could not be checked|Check again/i);
    assert.equal(actionButton(pane).textContent, "Check again");
  } finally { dispose(); dom.restore(); }
});

test("a stopped computer offers Start computer and posts start then rechecks", async () => {
  const scenario: Scenario = {
    posts: [],
    connection: () => ({
      status: "error", provider: "codex", model: "", computer_id: "cmp_1",
      message: "The bot’s computer is not running",
      recovery: { action: "start_computer", label: "Start computer" },
    }),
  };
  const { pane, dispose, dom } = await mountAi(scenario);
  try {
    const action = actionButton(pane);
    assert.equal(action.textContent, "Start computer");
    assert.match(pane.querySelector(".set-msg")!.textContent, /not running/);
    action.fire("click");
    await settle(6);
    assert.ok(scenario.posts.includes("/api/v1/computers/cmp_1/start"));
  } finally { dispose(); dom.restore(); }
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

test("guest sign-in relays official plain text and private replies, then clears on connection", async () => {
  let status = "signed_out";
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  const state = () => ({ status, provider: "claude", model: "claude-fable-5-1", login_mode: "terminal",
    execution_location: "computer", computer_id: "cmp_signin",
    ...(status === "signing_in" ? { native_terminal: { output: "<img src=x onerror=alert(1)>\nhttps://example.invalid/private-sign-in", can_reply: true } } : {}),
  });
  const scenario: Scenario = {
    posts: [], connection: provider => provider === "codex"
      ? { status: "signed_out", provider: "codex", model: "gpt-6-astra", execution_location: "computer" }
      : state(),
    onPost(path, body) {
      bodies.push({ path, body });
      if (path.endsWith("sign-in")) status = "signing_in";
      if (path.endsWith("input") && body.text === "private-login-reply") status = "signed_in";
      if (path.endsWith("connect")) status = "connected";
      return state();
    },
  };
  const { dom, pane, dispose } = await mountAi(scenario);
  try {
    assert.doesNotMatch(pane.textContent, /this Mac|command-line PATH/);
    assert.equal((pane.querySelector(".set-details input") as unknown as HTMLInputElement).maxLength, 512);
    assert.equal(actionButton(pane).textContent, "Sign in through Claude Code");
    actionButton(pane).fire("click");
    await settle(8);
    const panel = pane.querySelector(".set-terminal")!;
    const reply = panel.querySelector("input")!;
    assert.equal(panel.hidden, false);
    assert.match(panel.querySelector("pre")!.textContent, /<img src=x/);
    assert.equal(panel.querySelectorAll("img").length, 0);
    assert.equal(panel.querySelectorAll("a").length, 0, "CLI URLs stay plain text");
    panel.fire("submit");
    await settle(6);
    assert.deepEqual(bodies.find(item => item.path.endsWith("input"))!.body,
      { provider: "claude", computer_id: "cmp_signin", text: "" }, "an empty line sends native Enter");
    reply.value = "bad\0line";
    panel.fire("submit");
    assert.match(pane.textContent, /one line of up to 8,192/);
    assert.equal(bodies.filter(item => item.path.endsWith("input")).length, 1);
    reply.value = "private-login-reply";
    panel.fire("submit");
    assert.equal(reply.value, "", "clear private reply as soon as it is sent");
    await settle(8);
    assert.equal(status, "connected");
    assert.equal(panel.hidden, true);
    assert.equal(panel.querySelector("pre")!.textContent, "");
    assert.equal(bodies.find(item => item.path.endsWith("connect"))!.body.computer_id, "cmp_signin");
    assert.ok(bodies.every(item => !item.path.includes("tasks")));
    assert.doesNotMatch(JSON.stringify([...dom.storage]), /private-login-reply|private-sign-in/);
  } finally { dispose(); dom.restore(); }
});

test("cancel and disposal clear terminal output and ignore a late private reply", async () => {
  let status = "signing_in";
  let finishReply: ((value: Record<string, unknown>) => void) | undefined;
  const state = () => ({ status, provider: "claude", model: "claude-fable-5-1", login_mode: "terminal",
    execution_location: "computer", computer_id: "cmp_signin",
    ...(status === "signing_in" ? { native_terminal: { output: "private login instructions", can_reply: true } } : {}),
  });
  const scenario: Scenario = { posts: [], connection: () => state(),
    onPost(path) {
      if (path.endsWith("input")) return new Promise(resolve => { finishReply = resolve; });
      if (path.endsWith("cancel")) status = "signed_out";
      return state();
    },
  };
  const { dom, pane, dispose } = await mountAi(scenario);
  try {
    const panel = pane.querySelector(".set-terminal")!;
    panel.querySelector("input")!.value = "private reply";
    panel.fire("submit");
    await settle();
    byText(pane, "Cancel sign-in")!.fire("click");
    assert.equal(panel.hidden, true);
    assert.equal(panel.querySelector("pre")!.textContent, "");
    await settle(6);
    finishReply!({ status: "signing_in" });
    await settle(6);
    assert.equal(panel.hidden, true, "a late input response cannot restore a cancelled sign-in");
    status = "signing_in";
    byText(pane, "Check again")!.fire("click");
    await settle(6);
    assert.equal(panel.hidden, false);
    dispose();
    assert.equal(panel.hidden, true);
    assert.equal(panel.querySelector("pre")!.textContent, "");
    assert.equal(panel.querySelector("input")!.value, "");
  } finally { dispose(); dom.restore(); }
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
    const copied: string[] = [];
    navigator.clipboard.writeText = async text => { copied.push(text); };
    assert.equal(panel.hidden, false);
    assert.equal(panel.children[0]?.href, "https://auth.openai.com/codex/device");
    assert.equal(panel.children[0]?.textContent, "Copy code and open ChatGPT");
    assert.match(panel.textContent, /ABCD-12345/);
    panel.children[0]!.fire("click");
    await settle();
    assert.deepEqual(copied, ["ABCD-12345"]);

    challenge = { ...challenge, verification_uri: "https://attacker.invalid" };
    dom.runTimers();
    await settle();
    await settle();
    assert.equal(panel.hidden, true, "an unofficial verification page is never linked");
    assert.doesNotMatch(panel.textContent, /ABCD/);
    panel.children[0]!.fire("click");
    assert.deepEqual(copied, ["ABCD-12345"], "untrusted links cannot copy a sign-in code");

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

test("a connection conflict shows the actual reason without inventing a task restriction", async () => {
  const scenario: Scenario = {
    posts: [],
    connection: () => ({ status: "signed_in", provider: "claude", model: "" }),
  };
  const dom = installDom({ timers: "manual", hash: "#/settings", fetch: async (path, init) => {
    if (init?.method === "POST") {
      scenario.posts.push(path);
      return Response.json({ error: "E_CONNECTION_BUSY", message: "The connection check is already in progress." }, { status: 409 });
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
      /The connection check is already in progress\./,
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
    assert.match(rows[1]?.textContent ?? "", /Not installed yet/, "the other row is probed too");

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
    assert.match(pill.getAttribute("aria-label") ?? "", /Model connection: Claude · Opus 5/);
  } finally {
    dispose();
    dom.restore();
  }
});
