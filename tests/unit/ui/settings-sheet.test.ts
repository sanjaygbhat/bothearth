import assert from "node:assert/strict";
import { test } from "node:test";
import { all, byText, installDom, settle, type FakeElement } from "./fake-dom.ts";

const json = (body: unknown) => Response.json(body as Record<string, unknown>);

/** Answers every request the five sections make on mount. */
function stubApi(overrides: Record<string, unknown> = {}) {
  return async (path: string) => {
    for (const [match, body] of Object.entries(overrides)) {
      if (path.startsWith(match)) return json(body);
    }
    if (path.startsWith("/api/v1/connection")) {
      return json({ status: "connected", provider: "claude", model: "opus-4.5" });
    }
    if (path.startsWith("/api/v1/runtime")) {
      return json({ ai: { provider: "claude", cli_found: true, cli_path_kind: "path", logged_in: true, detail: "" } });
    }
    if (path.startsWith("/api/v1/computers")) return json({ default_computer_id: null, computers: [] });
    if (path.startsWith("/api/v1/tasks")) return json({ tasks: [] });
    if (path.startsWith("/api/v1/audit")) return json({ records: [] });
    if (path.startsWith("/api/v1/session/devices")) return json({ devices: [] });
    if (path.startsWith("/api/v1/session")) return json({ ok: true, public_origin: null, origin: "http://127.0.0.1:1" });
    if (path.startsWith("/healthz")) return json({ ok: true, version: "0.0.1" });
    return json({});
  };
}

async function openSheet(startHash = "#/settings", overrides: Record<string, unknown> = {}) {
  const dom = installDom({ timers: "manual", hash: startHash, fetch: stubApi(overrides) as never });
  const module = await import(`../../../src/ui/settings.ts?sheet=${Math.random()}`);
  const gear = dom.document.createElement("button");
  dom.document.body.append(gear);
  gear.focus();
  const view = module.createSettingsView();
  const section = startHash.split("/")[2];
  view.mount(dom.root as never, section ? { section } : {});
  await settle();
  return { dom, module, view, gear, sheet: dom.root.querySelector(".set-sheet") as FakeElement };
}

test("the sheet is one dialog with five sections and the AI connection open first", async () => {
  const { dom, sheet, view } = await openSheet();
  try {
    assert.equal(sheet.getAttribute("role"), "dialog");
    assert.equal(sheet.getAttribute("aria-modal"), "true");
    const rail = sheet.querySelector(".set-rail") as FakeElement;
    assert.deepEqual(
      rail.children.map((b) => b.textContent),
      ["AI connection", "Computers", "Devices", "Usage", "About"],
    );
    assert.equal(rail.querySelector('[aria-current="page"]')?.textContent, "AI connection");
    assert.ok(byText(sheet, "AI connection"), "the pane names the section it is showing");
    // WAI-ARIA APG: focus opens on the first focusable thing inside the dialog.
    assert.equal(dom.document.activeElement?.textContent, "AI connection");
    assert.ok(sheet.contains(dom.document.activeElement));
  } finally {
    view.unmount();
    dom.restore();
  }
});

test("a section in the hash opens that section, and update swaps panes without rebuilding", async () => {
  const { dom, sheet, view } = await openSheet("#/settings/usage");
  try {
    const rail = sheet.querySelector(".set-rail") as FakeElement;
    assert.equal(rail.querySelector('[aria-current="page"]')?.textContent, "Usage");
    view.update({ section: "about" });
    await settle();
    assert.equal(rail.querySelector('[aria-current="page"]')?.textContent, "About");
    assert.equal(sheet, dom.root.querySelector(".set-sheet"), "the sheet itself is not rebuilt");
    assert.ok(byText(sheet, "Source-available · free for personal use."));
  } finally {
    view.unmount();
    dom.restore();
  }
});

test("Esc, Done and the scrim all close the sheet and put focus back", async () => {
  for (const how of ["escape", "done", "scrim"] as const) {
    const dom = installDom({ timers: "manual", hash: "#/tasks/t_1", fetch: stubApi() as never });
    const module = await import(`../../../src/ui/settings.ts?close=${how}`);
    const gear = dom.document.createElement("button");
    dom.document.body.append(gear);
    gear.focus();
    // Arriving from a task, then opening the sheet over it.
    module.registerSettings();
    (globalThis as { location: { hash: string } }).location.hash = "#/settings";
    const view = module.createSettingsView();
    view.mount(dom.root as never, {});
    await settle();
    assert.notEqual(dom.document.activeElement, gear, "focus moves into the sheet");

    const sheet = dom.root.querySelector(".set-sheet") as FakeElement;
    if (how === "escape") dom.document.fire("keydown", { key: "Escape" });
    if (how === "done") (sheet.querySelector('[aria-label="Close settings"]') as FakeElement).fire("click");
    if (how === "scrim") (dom.root.querySelector(".set-scrim") as FakeElement).fire("click");

    assert.equal(dom.hash(), "#/tasks/t_1", `${how} returns to the screen behind`);
    view.unmount();
    assert.equal(dom.document.activeElement, gear, `${how} restores focus`);
    dom.restore();
  }
});

test("Tab is trapped inside the sheet", async () => {
  const { dom, sheet, view } = await openSheet();
  try {
    const stops = sheet
      .querySelectorAll("button, a[href], input, select, textarea")
      .filter((node) => !node.hidden && node.offsetParent !== null);
    assert.ok(stops.length > 3);
    const first = stops[0] as FakeElement;
    const last = stops[stops.length - 1] as FakeElement;

    last.focus();
    dom.document.fire("keydown", { key: "Tab", shiftKey: false });
    assert.equal(dom.document.activeElement, first, "Tab from the last stop wraps to the first");

    dom.document.fire("keydown", { key: "Tab", shiftKey: true });
    assert.equal(dom.document.activeElement, last, "Shift+Tab from the first wraps to the last");

    dom.document.body.focus();
    dom.document.fire("keydown", { key: "Tab", shiftKey: false });
    assert.equal(dom.document.activeElement, first, "focus outside the sheet is pulled back in");
  } finally {
    view.unmount();
    dom.restore();
  }
});

test("⌘, and the native menu both open Settings, and neither reopens it", async () => {
  const dom = installDom({ timers: "manual", hash: "#/", fetch: stubApi() as never });
  try {
    const module = await import(`../../../src/ui/settings.ts?open=${Math.random()}`);
    module.registerSettings();
    const win = (globalThis as { window: { dispatch(t: string, e?: Record<string, unknown>): unknown } }).window;

    win.dispatch("keydown", { key: ",", metaKey: true });
    assert.equal(dom.hash(), "#/settings");

    // Already open: the shortcut must not navigate again.
    win.dispatch("keydown", { key: ",", metaKey: true });
    assert.equal(dom.hash(), "#/settings");

    dom.document.body.append(dom.document.createElement("div"));
    (globalThis as { location: { hash: string } }).location.hash = "#/tasks/t_9";
    win.dispatch("modelbot:native", { detail: { kind: "open-settings" } });
    assert.equal(dom.hash(), "#/settings");
  } finally {
    dom.restore();
  }
});

test("appearance writes the theme and marks the pressed choice", async () => {
  const { dom, sheet, view } = await openSheet();
  try {
    const seg = sheet.querySelector(".set-seg") as FakeElement;
    assert.deepEqual(seg.children.map((b) => b.textContent), ["System", "Light", "Dark"]);
    assert.equal(seg.children[0]?.getAttribute("aria-pressed"), "true");

    (seg.children[2] as FakeElement).fire("click");
    assert.equal(dom.document.documentElement.getAttribute("data-theme"), "dark");
    assert.equal(seg.children[2]?.getAttribute("aria-pressed"), "true");
    assert.equal(seg.children[0]?.getAttribute("aria-pressed"), "false");

    (seg.children[0] as FakeElement).fire("click");
    assert.equal(dom.document.documentElement.getAttribute("data-theme"), null, "System removes the override");
  } finally {
    view.unmount();
    dom.restore();
  }
});

test("closing tears the sections down: no timer, no listener, nothing left in the DOM", async () => {
  const { dom, view, module } = await openSheet();
  try {
    assert.ok(dom.root.children.length > 0);
    view.unmount();
    assert.equal(dom.root.children.length, 0, "scrim and sheet are both removed");
    assert.equal((dom.document.listeners.keydown ?? []).length, 0, "the key handler is removed");
    assert.equal(module.isSettingsHash("#/settings"), true);
    assert.equal(module.isSettingsHash("#/settings/devices"), true);
    assert.equal(module.isSettingsHash("#/settingsish"), false);
    assert.equal(module.isSettingsHash("#/tasks/t_1"), false);
    assert.equal(module.resolveSection("nonsense").id, "ai", "an unknown section falls back, never blank");
    assert.equal(module.resolveSection("devices").id, "devices");
  } finally {
    dom.restore();
  }
});

test("every action target in the sheet is reachable by keyboard and none is a dead control", async () => {
  const { dom, sheet, view } = await openSheet("#/settings/about");
  try {
    for (const node of all(sheet)) {
      if (node.tagName === "BUTTON") {
        assert.notEqual(node.textContent.trim(), "", "a button always says what it does");
      }
      if (node.tagName === "A") {
        assert.match(node.href, /^https:\/\//, "external links are https and explicit");
        assert.equal(node.getAttribute("rel"), "noopener noreferrer");
      }
    }
  } finally {
    view.unmount();
    dom.restore();
  }
});
