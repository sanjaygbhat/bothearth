import assert from "node:assert/strict";
import { test } from "node:test";
import { all, installDom, settle, type FakeElement } from "./fake-dom.ts";

/**
 * The two rules the Settings screen has to keep, kept
 * here now that the sheet owns them:
 *   1. arriving in Settings only reads; it never signs anything in;
 *   2. a check that comes back "connected" is not permission to leave — the
 *      sheet stays open until the person closes it.
 */

const json = (body: unknown) => Response.json(body as Record<string, unknown>);
const text = (node: FakeElement) => all(node).map((n) => n.textContent).join(" ");

async function openAt(hash: string, reply: () => Record<string, unknown>, seen: string[]) {
  const dom = installDom({ timers: "manual", hash, fetch: async (path, init) => {
    seen.push(`${init?.method ?? "GET"} ${path}`);
    if (path.startsWith("/api/v1/connection")) return json(reply());
    if (path.startsWith("/api/v1/runtime"))
      return json({ ai: { provider: "claude", cli_found: true, cli_path_kind: "well-known", logged_in: null, detail: "" } });
    if (path.startsWith("/api/v1/session/devices")) return json({ devices: [] });
    if (path.startsWith("/api/v1/session")) return json({ ok: true, spend_cap_usd: 2, origin: "https://fixture.example" });
    if (path.startsWith("/api/v1/computers")) return json({ default_computer_id: null, computers: [] });
    if (path.startsWith("/api/v1/tasks")) return json({ tasks: [] });
    if (path.startsWith("/api/v1/audit")) return json({ records: [] });
    return json({ ok: true, version: "0.4.2" });
  } });
  const module = await import(`../../../src/ui/settings.ts?readiness=${Math.random()}`);
  const view = module.createSettingsView();
  view.mount(dom.root as never, {});
  await settle();
  await settle();
  return { dom, view, pane: dom.root.querySelector(".set-pane") as FakeElement };
}

test("entering Settings reads the current state and signs nothing in", async () => {
  const seen: string[] = [];
  const { dom, view, pane } = await openAt("#/settings", () => ({
    status: "signed_out",
    provider: "claude",
    model: "",
  }), seen);
  try {
    assert.equal(
      seen.every((call) => call.startsWith("GET ")),
      true,
      `only reads on mount, saw: ${seen.join(", ")}`,
    );
    assert.match(text(pane), /Not signed in/);
    assert.match(text(pane), /Sign in through Claude Code/);
  } finally {
    view.unmount();
    dom.restore();
  }
});

test("a stale idea of the connection is replaced by what the daemon says now", async () => {
  const seen: string[] = [];
  let status = "connected";
  const { dom, view, pane } = await openAt("#/settings", () => ({
    status,
    provider: "claude",
    model: "Opus 4.5",
  }), seen);
  try {
    assert.match(text(pane), /Connected · last checked a moment ago/);

    // The CLI is signed out behind our back; "Check again" must tell the truth.
    status = "signed_out";
    const recheck = all(pane).find((n) => n.textContent === "Check again") as FakeElement;
    recheck.fire("click");
    await settle();
    await settle();
    assert.match(text(pane), /Not signed in/);
    assert.doesNotMatch(text(pane), /Connected · last checked/);
  } finally {
    view.unmount();
    dom.restore();
  }
});

test("a successful check is not permission to leave the sheet", async () => {
  const seen: string[] = [];
  const { dom, view, pane } = await openAt("#/settings", () => ({
    status: "connected",
    provider: "claude",
    model: "Opus 4.5",
  }), seen);
  try {
    assert.equal(dom.hash(), "#/settings", "nothing navigates on its own");
    const recheck = all(pane).find((n) => n.textContent === "Check again") as FakeElement;
    recheck.fire("click");
    await settle();
    await settle();
    assert.equal(dom.hash(), "#/settings", "and still nothing after a green check");
  } finally {
    view.unmount();
    dom.restore();
  }
});

test("nothing user-facing leaks an identifier, a path or a gate name", async () => {
  const seen: string[] = [];
  const { dom, view, pane } = await openAt("#/settings", () => ({
    status: "connected",
    provider: "claude",
    model: "Opus 4.5",
  }), seen);
  try {
    const visible = all(pane)
      .filter((node) => node.tagName !== "DETAILS" && !all(node).some((n) => n.tagName === "DETAILS"))
      .map((n) => n.textContent)
      .join(" ");
    for (const banned of [
      "daemon",
      "bootstrap",
      "computer_id",
      "csrf",
      "control_epoch",
      "new_domain",
      "external_send",
      "spend cap",
      "workspace",
    ]) {
      assert.doesNotMatch(visible.toLowerCase(), new RegExp(banned), `jargon leaked: ${banned}`);
    }
  } finally {
    view.unmount();
    dom.restore();
  }
});
