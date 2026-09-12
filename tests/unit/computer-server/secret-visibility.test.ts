/**
 * A signed-in chatgpt.com page asked for a password that was not on screen:
 * a hidden autofill trap (`display:none`) and a zero-size `aria-hidden` input
 * were marked as credential fields, so every click requested takeover and
 * release stayed blocked.
 *
 * w27 still let through a non-zero `left:-9999px` box, a 1×1 px target, and
 * `pointer-events:none` — checkVisibility + non-zero rect is not enough.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { chromiumAvailable } from "../../../computer-server/src/browser/session.ts";
import { createState, dispatch } from "../../../computer-server/src/dispatch.ts";
import { markSecretFields, SECRET_MASK_SELECTORS } from "../../../computer-server/src/redact.ts";

type Attrs = Record<string, string>;

function fakeField(opts: {
  attrs?: Attrs;
  box: { x: number; y: number; w: number; h: number };
  pointerEvents?: string;
  visible?: boolean;
  tagName?: string;
  contentEditable?: boolean;
}) {
  const tagName = (opts.tagName ?? "INPUT").toUpperCase();
  const own: Attrs =
    tagName === "INPUT" ? { type: "password", name: "password", ...opts.attrs } : { ...opts.attrs };
  const box = opts.box;
  return {
    getAttribute: (name: string) => own[name] ?? null,
    setAttribute: (name: string, value: string) => {
      own[name] = value;
    },
    removeAttribute: (name: string) => {
      delete own[name];
    },
    hasAttribute: (name: string) => name in own,
    isContentEditable: opts.contentEditable === true,
    isConnected: true,
    tagName,
    classList: { contains: () => false },
    matches: () => false,
    closest: () => null,
    checkVisibility: () => opts.visible !== false,
    getBoundingClientRect: () => ({
      x: box.x,
      y: box.y,
      width: box.w,
      height: box.h,
      left: box.x,
      top: box.y,
      right: box.x + box.w,
      bottom: box.y + box.h,
    }),
    pointerEvents: opts.pointerEvents ?? "auto",
    mark: () => own["data-modelbot-secret"] ?? null,
  };
}

type FakeField = ReturnType<typeof fakeField>;

function markOnPage(elements: FakeField[]) {
  const globals = globalThis as unknown as Record<string, unknown>;
  const styleAttrs: Attrs = {};
  const style = {
    id: "",
    textContent: "",
    setAttribute: (name: string, value: string) => {
      styleAttrs[name] = value;
    },
    getAttribute: (name: string) => styleAttrs[name] ?? null,
    removeAttribute: (name: string) => {
      delete styleAttrs[name];
    },
  };
  const previous = {
    location: globals.location,
    document: globals.document,
    getComputedStyle: globals.getComputedStyle,
  };
  globals.location = { href: "https://chatgpt.com/" };
  globals.getComputedStyle = (el: FakeField) => ({ pointerEvents: el.pointerEvents });
  globals.document = {
    querySelectorAll: () => elements,
    getElementById: () => null,
    createElement: () => style,
    documentElement: { appendChild: () => undefined, scrollWidth: 1280, scrollHeight: 800 },
    defaultView: { innerWidth: 1280, innerHeight: 800, scrollX: 0, scrollY: 0 },
  };
  try {
    const found = markSecretFields(SECRET_MASK_SELECTORS);
    return { found, detail: style.getAttribute("data-modelbot-detail") };
  } finally {
    if (previous.location === undefined) delete globals.location;
    else globals.location = previous.location;
    if (previous.document === undefined) delete globals.document;
    else globals.document = previous.document;
    if (previous.getComputedStyle === undefined) delete globals.getComputedStyle;
    else globals.getComputedStyle = previous.getComputedStyle;
  }
}

describe("password fields a person can type into (predicate)", () => {
  it("rejects a left:-9999px box even when checkVisibility and size are non-zero", () => {
    const trap = fakeField({
      attrs: { name: "trap", autocomplete: "current-password" },
      box: { x: -9999, y: 0, w: 20, h: 20 },
    });
    const result = markOnPage([trap]);
    assert.deepEqual(result.found, []);
    assert.equal(trap.mark(), null);
    assert.equal(result.detail, null);
  });

  it("rejects a target smaller than 8px", () => {
    const tiny = fakeField({
      attrs: { name: "tiny", autocomplete: "current-password" },
      box: { x: 10, y: 10, w: 7, h: 7 },
    });
    const result = markOnPage([tiny]);
    assert.deepEqual(result.found, []);
    assert.equal(tiny.mark(), null);
  });

  it("rejects pointer-events:none", () => {
    const frozen = fakeField({
      attrs: { name: "frozen", autocomplete: "current-password" },
      box: { x: 10, y: 10, w: 40, h: 32 },
      pointerEvents: "none",
    });
    const result = markOnPage([frozen]);
    assert.deepEqual(result.found, []);
    assert.equal(frozen.mark(), null);
  });

  it("reports a visible password with a compact detail list", () => {
    const box = fakeField({
      attrs: { name: "password", "aria-label": "Enter password", autocomplete: "current-password" },
      box: { x: 8, y: 12, w: 240, h: 32 },
    });
    const result = markOnPage([box]);
    assert.deepEqual(result.found, [{ kind: "password", label: "Enter password" }]);
    assert.equal(box.mark(), "password");
    assert.ok(result.detail);
    const rows = JSON.parse(result.detail!) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.tag, "input");
    assert.equal(rows[0]!.type, "password");
    assert.equal(rows[0]!.name, "password");
    assert.deepEqual(rows[0]!.rect, { x: 8, y: 12, w: 240, h: 32 });
    assert.equal(rows[0]!.inViewport, true);
    assert.equal(rows[0]!.connected, true);
    assert.equal(rows[0]!.visible, true);
    assert.equal(rows[0]!.sized, true);
    assert.equal(rows[0]!.intersects, true);
    assert.equal(rows[0]!.pointer, true);
    assert.ok(result.detail!.length <= 400);
  });

  it("counts a visible password next to a ChatGPT composer, not the composer", () => {
    const composer = fakeField({
      tagName: "DIV",
      contentEditable: true,
      attrs: {
        role: "textbox",
        "aria-label": "Chat with ChatGPT",
        autocomplete: "off",
      },
      box: { x: 433, y: 319, w: 535, h: 42 },
    });
    const box = fakeField({
      attrs: { name: "password", type: "password", autocomplete: "current-password" },
      box: { x: 8, y: 12, w: 240, h: 32 },
    });
    const result = markOnPage([composer, box]);
    assert.deepEqual(result.found, [{ kind: "password", label: "password" }]);
    assert.equal(composer.mark(), null);
    assert.equal(box.mark(), "password");
    const rows = JSON.parse(result.detail!) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.tag, "input");
    assert.equal(rows[0]!.type, "password");
    assert.notEqual(rows[0]!.name, "Chat with ChatGPT");
  });

  it("leaves a composer-only page with no header, kinds, or marker", () => {
    const composer = fakeField({
      tagName: "DIV",
      contentEditable: true,
      attrs: {
        role: "textbox",
        "aria-label": "Chat with ChatGPT",
        autocomplete: "off",
      },
      box: { x: 433, y: 319, w: 535, h: 42 },
    });
    const result = markOnPage([composer]);
    assert.deepEqual(result.found, []);
    assert.equal(composer.mark(), null);
    assert.equal(result.detail, null);
  });

  it("counts a textarea with autocomplete=new-password", () => {
    const box = fakeField({
      tagName: "TEXTAREA",
      attrs: { name: "password", autocomplete: "new-password" },
      box: { x: 8, y: 12, w: 240, h: 32 },
    });
    const result = markOnPage([box]);
    assert.deepEqual(result.found, [{ kind: "password", label: "password" }]);
    assert.equal(box.mark(), "password");
    const rows = JSON.parse(result.detail!) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.tag, "textarea");
    assert.equal(rows[0]!.name, "password");
  });
});

const hasChromium = await chromiumAvailable().catch(() => false);

const HIDDEN =
  "<html><body>" +
  '<input type="password" name="trap" style="display:none" autocomplete="current-password">' +
  '<div aria-hidden="true">' +
  '<input type="password" name="offscreen" autocomplete="current-password" ' +
  'style="position:absolute;left:-9999px;width:0;height:0;min-width:0;min-height:0;' +
  'padding:0;border:0;overflow:hidden">' +
  "</div>" +
  '<input name="q" aria-label="Ask anything" type="text">' +
  "</body></html>";

const LOGIN =
  "<html><body>" +
  '<input type="password" name="trap" style="display:none" autocomplete="current-password">' +
  '<div aria-hidden="true">' +
  '<input type="password" name="offscreen" autocomplete="current-password" ' +
  'style="position:absolute;left:-9999px;width:0;height:0;min-width:0;min-height:0;' +
  'padding:0;border:0;overflow:hidden">' +
  "</div>" +
  '<label>Password <input type="password" name="password" autocomplete="current-password"></label>' +
  "</body></html>";

const TRAPS =
  "<html><body>" +
  '<input type="password" name="parked" autocomplete="current-password" ' +
  'style="position:absolute;left:-9999px;width:20px;height:20px">' +
  '<input type="password" name="tiny" autocomplete="current-password" ' +
  'style="width:1px;height:1px;min-width:0;min-height:0;padding:0;border:0;font-size:1px">' +
  '<input type="password" name="nopointer" autocomplete="current-password" ' +
  'style="pointer-events:none;width:40px;height:32px">' +
  '<input name="q" aria-label="Ask ChatGPT" type="text">' +
  "</body></html>";

const COMPOSER =
  "<html><body>" +
  '<div contenteditable="true" role="textbox" aria-label="Chat with ChatGPT" autocomplete="off"></div>' +
  "</body></html>";

const COMPOSER_AND_PASSWORD =
  "<html><body>" +
  '<div contenteditable="true" role="textbox" aria-label="Chat with ChatGPT" autocomplete="off"></div>' +
  '<label>Password <input type="password" name="password" autocomplete="current-password"></label>' +
  "</body></html>";

const NEW_PASSWORD =
  "<html><body>" +
  '<textarea name="password" autocomplete="new-password"></textarea>' +
  "</body></html>";

describe("password fields a person can type into", () => {
  it("ignores hidden traps and reports a visible password", {
    skip: !hasChromium && "Host Chromium unavailable",
  }, async (t) => {
    process.env.MODELBOT_WORKSPACE = mkdtempSync(join(tmpdir(), "mb-vis-ws-"));
    process.env.MODELBOT_PROFILE = mkdtempSync(join(tmpdir(), "mb-vis-pf-"));
    process.env.MODELBOT_QUARANTINE = mkdtempSync(join(tmpdir(), "mb-vis-q-"));
    process.env.MODELBOT_PROXY_SERVER = "http://127.0.0.1:9";
    process.env.MODELBOT_PROXY_BYPASS = "127.0.0.1";
    const fixture = createServer((req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(
        req.url?.startsWith("/login")
          ? LOGIN
          : req.url?.startsWith("/traps")
            ? TRAPS
            : req.url?.startsWith("/composer-password")
              ? COMPOSER_AND_PASSWORD
              : req.url?.startsWith("/composer")
                ? COMPOSER
                : req.url?.startsWith("/new-password")
                  ? NEW_PASSWORD
                  : HIDDEN,
      );
    });
    await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const address = fixture.address();
    assert.ok(address && typeof address === "object");
    const state = createState("browser");
    t.after(async () => {
      await state.browser?.close();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
    });

    const snapshot = async (path: string) => {
      const nav = await dispatch(state, {
        jsonrpc: "2.0",
        id: 1,
        method: "browser_navigate",
        params: { url: `http://127.0.0.1:${address.port}${path}`, wait_until: "load" },
      });
      assert.equal(nav.ok, true);
      const snap = await dispatch(state, {
        jsonrpc: "2.0",
        id: 2,
        method: "browser_snapshot",
        params: { scope: null, interactive_only: false, depth: null, max_chars: 8000 },
      });
      assert.equal(snap.ok, true);
      return snap.ok ? (snap.data as { yaml: string }).yaml : "";
    };

    const marks = async () =>
      state.browser!.requirePage().evaluate(() =>
        [...document.querySelectorAll("input[type=password]")].map((node) => ({
          name: (node as HTMLInputElement).name,
          mark: node.getAttribute("data-modelbot-secret"),
        })),
      );

    const observation = async () => {
      const result = await dispatch(state, {
        jsonrpc: "2.0",
        id: 3,
        method: "takeover.masked-observation",
        params: {},
      });
      assert.equal(result.ok, true);
      return result.ok
        ? (result.data as { still_sensitive: boolean; field: { kind: string } | null })
        : { still_sensitive: true, field: null };
    };

    const hiddenYaml = await snapshot("/hidden");
    assert.doesNotMatch(
      hiddenYaml,
      /modelbot_sensitive_fields/,
      "a page with only hidden password traps is not a login",
    );
    assert.deepEqual(await marks(), [
      { name: "trap", mark: null },
      { name: "offscreen", mark: null },
    ]);
    const hiddenObs = await observation();
    assert.equal(hiddenObs.still_sensitive, false);
    assert.equal(hiddenObs.field, null);

    const loginYaml = await snapshot("/login");
    assert.match(loginYaml, /^modelbot_sensitive_fields: 1 password\n/);
    assert.match(loginYaml, /^modelbot_sensitive_detail: \[/m);
    const detailLine = /^modelbot_sensitive_detail: ([^\n]*)/m.exec(loginYaml);
    assert.ok(detailLine);
    const rows = JSON.parse(detailLine![1]!) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.tag, "input");
    assert.equal(rows[0]!.type, "password");
    assert.equal(typeof rows[0]!.name, "string");
    assert.equal(typeof (rows[0]!.rect as { w?: unknown })?.w, "number");
    assert.equal(typeof rows[0]!.inViewport, "boolean");
    assert.ok(detailLine![1]!.length <= 400);
    assert.deepEqual(await marks(), [
      { name: "trap", mark: null },
      { name: "offscreen", mark: null },
      { name: "password", mark: "password" },
    ]);
    const loginObs = await observation();
    assert.equal(loginObs.still_sensitive, true);
    assert.equal(loginObs.field?.kind, "password");

    const trapYaml = await snapshot("/traps");
    assert.doesNotMatch(
      trapYaml,
      /modelbot_sensitive_fields/,
      "offscreen, tiny and pointer-events:none password boxes are not a login",
    );
    assert.deepEqual(await marks(), [
      { name: "parked", mark: null },
      { name: "tiny", mark: null },
      { name: "nopointer", mark: null },
    ]);
    const trapObs = await observation();
    assert.equal(trapObs.still_sensitive, false);

    const mixedYaml = await snapshot("/composer-password");
    assert.match(mixedYaml, /^modelbot_sensitive_fields: 1 password\n/);
    const mixedLine = /^modelbot_sensitive_detail: ([^\n]*)/m.exec(mixedYaml);
    assert.ok(mixedLine);
    const mixedRows = JSON.parse(mixedLine![1]!) as Array<Record<string, unknown>>;
    assert.equal(mixedRows.length, 1);
    assert.equal(mixedRows[0]!.tag, "input");
    assert.notEqual(mixedRows[0]!.name, "Chat with ChatGPT");
    const mixedMarks = await state.browser!.requirePage().evaluate(() => ({
      composer: document.querySelector("[contenteditable]")?.getAttribute("data-modelbot-secret"),
      password: document
        .querySelector("input[type=password]")
        ?.getAttribute("data-modelbot-secret"),
    }));
    assert.equal(mixedMarks.composer, null);
    assert.equal(mixedMarks.password, "password");

    const composerYaml = await snapshot("/composer");
    assert.doesNotMatch(composerYaml, /modelbot_sensitive_fields/);
    const composerMark = await state
      .browser!.requirePage()
      .evaluate(() =>
        document.querySelector("[contenteditable]")?.getAttribute("data-modelbot-secret"),
      );
    assert.equal(composerMark, null);

    const textareaYaml = await snapshot("/new-password");
    assert.match(textareaYaml, /^modelbot_sensitive_fields: 1 password\n/);
    const textareaLine = /^modelbot_sensitive_detail: ([^\n]*)/m.exec(textareaYaml);
    assert.ok(textareaLine);
    const textareaRows = JSON.parse(textareaLine![1]!) as Array<Record<string, unknown>>;
    assert.equal(textareaRows.length, 1);
    assert.equal(textareaRows[0]!.tag, "textarea");
    assert.equal(textareaRows[0]!.name, "password");
  });
});
