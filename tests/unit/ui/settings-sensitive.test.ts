import assert from "node:assert/strict";
import { test } from "node:test";
import { all, installDom, settle, type FakeElement } from "./fake-dom.ts";

const json = (body: unknown) => Response.json(body as Record<string, unknown>);
const text = (node: FakeElement) => all(node).map((n) => n.textContent).join(" ");
const ALL_GATES = [
  "external_send",
  "payment",
  "upload",
  "delete",
  "secret_entry",
  "new_domain",
] as const;

async function mountSensitive(
  session: Record<string, unknown>,
  posts: Array<Record<string, unknown>>,
) {
  const state = { ...session };
  const dom = installDom({
    timers: "manual",
    hash: "#/settings/sensitive",
    fetch: async (path, init) => {
      if (path.startsWith("/api/v1/session/devices")) return json({ devices: [] });
      if (path.startsWith("/api/v1/session")) {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
          posts.push(body);
          if (typeof body.ask_before_sensitive === "boolean") {
            state.ask_before_sensitive = body.ask_before_sensitive;
            state.policy_gates = body.ask_before_sensitive
              ? (body.policy_gates ?? [...ALL_GATES])
              : [];
          }
          if (typeof body.max_steps === "number" || typeof body.spend_cap_usd === "number") {
            const prev =
              (state.limits as { max_steps?: number; spend_cap_usd?: number } | undefined) ?? {};
            state.limits = {
              max_steps: typeof body.max_steps === "number" ? body.max_steps : (prev.max_steps ?? 0),
              spend_cap_usd:
                typeof body.spend_cap_usd === "number" ? body.spend_cap_usd : (prev.spend_cap_usd ?? 0),
            };
          }
          return json({
            ok: true,
            ask_before_sensitive: state.ask_before_sensitive,
            policy_gates: state.policy_gates,
            limits: state.limits,
          });
        }
        return json({ ok: true, origin: "https://fixture.example", ...state });
      }
      if (path.startsWith("/api/v1/connection")) {
        return json({ status: "connected", provider: "claude", model: "Opus 4.5" });
      }
      if (path.startsWith("/api/v1/runtime")) {
        return json({
          ai: { provider: "claude", cli_found: true, cli_path_kind: "path", logged_in: true, detail: "" },
        });
      }
      if (path.startsWith("/api/v1/computers")) return json({ default_computer_id: null, computers: [] });
      if (path.startsWith("/api/v1/tasks")) return json({ tasks: [] });
      if (path.startsWith("/healthz")) return json({ ok: true, version: "0.4.2" });
      return json({});
    },
  });
  const module = await import(`../../../src/ui/settings.ts?sensitive=${Math.random()}`);
  const view = module.createSettingsView();
  view.mount(dom.root as never, { section: "sensitive" });
  await settle();
  await settle();
  return { dom, view, pane: dom.root.querySelector(".set-pane") as FakeElement };
}

test("Sensitive actions toggle is off by default and round-trips on then off", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const { dom, view, pane } = await mountSensitive(
    { ask_before_sensitive: false, policy_gates: [], limits: { max_steps: 0, spend_cap_usd: 0 } },
    posts,
  );
  try {
    assert.match(text(pane), /Ask before sensitive actions/);
    assert.match(
      text(pane),
      /Ask before detected sends, uploads, deletes, checkout steps and new-site form submits made through BotHearth’s browser tools\. The bot pauses only when it asks, or when you enable Ask before sensitive actions\./,
    );
    assert.match(text(pane), /Sending email or messages/);
    assert.match(text(pane), /Checkout steps \(card entry always pauses for you\)/);
    assert.doesNotMatch(text(pane), /Payments and purchases/);
    assert.match(text(pane), /Maximum tool calls/);
    assert.doesNotMatch(text(pane).toLowerCase(), /external_send|secret_entry|new_domain/);

    const master = pane.querySelector("input") as FakeElement;
    assert.equal(master.checked, false);
    const subs = pane.querySelectorAll("input[data-gate]");
    assert.equal(subs.length, 6);
    assert.ok(subs.every((box) => box.disabled), "sub-checkboxes are off while the master is off");

    master.checked = true;
    master.fire("change");
    await settle();
    await settle();
    assert.deepEqual(posts[0], { ask_before_sensitive: true, policy_gates: [...ALL_GATES] });
    assert.match(text(pane), /On\. BotHearth will ask before those actions/);
    assert.ok(subs.every((box) => !box.disabled && box.checked));

    master.checked = false;
    master.fire("change");
    await settle();
    await settle();
    assert.deepEqual(posts[1], { ask_before_sensitive: false });
    assert.match(text(pane), /Off\. Tasks will not stop for those actions/);
    assert.ok(subs.every((box) => box.disabled));
  } finally {
    view.unmount();
    dom.restore();
  }
});

test("Sensitive actions renders a saved gate subset and disables subs when the master is off", async () => {
  const posts: Array<Record<string, unknown>> = [];
  const { dom, view, pane } = await mountSensitive(
    { ask_before_sensitive: true, policy_gates: ["payment", "upload"], limits: { max_steps: 0, spend_cap_usd: 0 } },
    posts,
  );
  try {
    const master = pane.querySelector("input") as FakeElement;
    assert.equal(master.checked, true);
    const checked = pane
      .querySelectorAll("input[data-gate]")
      .filter((box) => box.checked)
      .map((box) => box.dataset.gate);
    assert.deepEqual(checked, ["payment", "upload"]);
    assert.ok(pane.querySelectorAll("input[data-gate]").every((box) => !box.disabled));

    const payment = pane.querySelectorAll("input[data-gate]").find((box) => box.dataset.gate === "payment")!;
    payment.checked = false;
    payment.fire("change");
    await settle();
    await settle();
    assert.deepEqual(posts[0], { ask_before_sensitive: true, policy_gates: ["upload"] });

    master.checked = false;
    master.fire("change");
    await settle();
    await settle();
    assert.ok(pane.querySelectorAll("input[data-gate]").every((box) => box.disabled));
  } finally {
    view.unmount();
    dom.restore();
  }
});
