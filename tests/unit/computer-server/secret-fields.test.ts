/**
 * A signed-in Gmail search page asked its owner for a 2-step code that was not
 * on screen, and cost the task three and a half minutes parked in needs-you.
 * The page had no credential field at all: the old rule marked every
 * `input[inputmode="numeric"]`, anywhere.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  SECRET_MASK_SELECTORS,
  type SensitiveField,
  markSecretFields,
} from "../../../computer-server/src/redact.ts";
import {
  BrowserSession,
  chromiumAvailable,
} from "../../../computer-server/src/browser/session.ts";
import { createState, dispatch } from "../../../computer-server/src/dispatch.ts";

type Attrs = Record<string, string>;

function element(attrs: Attrs, contentEditable?: string) {
  const own: Attrs = { ...attrs };
  return {
    getAttribute: (name: string) => own[name] ?? null,
    setAttribute: (name: string, value: string) => {
      own[name] = value;
    },
    removeAttribute: (name: string) => {
      delete own[name];
    },
    hasAttribute: (name: string) => name in own,
    isContentEditable: contentEditable === "true",
    tagName: contentEditable === "true" ? "DIV" : "INPUT",
    classList: { contains: (name: string) => (own.class ?? "").split(/\s+/).includes(name) },
    mark: () => own["data-modelbot-secret"] ?? null,
  };
}

type Element = ReturnType<typeof element>;

/** Runs the real in-page marker against a page of `elements` at `url`. */
function onPage(url: string, elements: Element[]): SensitiveField[] {
  const globals = globalThis as unknown as Record<string, unknown>;
  const style = { id: "", textContent: "" };
  globals.location = { href: url };
  globals.document = {
    querySelectorAll: () => elements,
    getElementById: () => null,
    createElement: () => style,
    documentElement: { appendChild: () => undefined },
  };
  try {
    return markSecretFields(SECRET_MASK_SELECTORS);
  } finally {
    delete globals.location;
    delete globals.document;
  }
}

const GMAIL_SEARCH = "https://mail.google.com/mail/u/0/#search/from%3Areddit";
const GOOGLE_2SV = "https://accounts.google.com/v3/signin/challenge/totp";

describe("credential fields the page itself declares", () => {
  it("leaves a Gmail search page alone", () => {
    // The search box, the compose subject line and a numeric page-size box:
    // what was actually on screen when the bot asked for a code.
    const search = element({
      name: "q",
      id: "gs_lc0",
      "aria-label": "Search mail",
      type: "text",
      autocomplete: "off",
      role: "combobox",
    });
    const subject = element({ name: "subjectbox", "aria-label": "Subject", type: "text" });
    const perPage = element({ name: "mpp", type: "text", inputmode: "numeric", maxlength: "3" });

    assert.deepEqual(onPage(GMAIL_SEARCH, [search, subject, perPage]), [],
      "a short numeric box off an auth page is not a code box to ask about");
    assert.equal(search.mark(), null);
    assert.equal(subject.mark(), null);
    // Masked all the same. Hiding a value costs nothing and a typed code must
    // never reach the transcript; what it must not do is stop the task.
    assert.equal(perPage.mark(), "otp");
  });

  it("marks the code box Google's 2-step verification puts on screen", () => {
    const totp = element({
      type: "tel",
      name: "totpPin",
      id: "totpPin",
      "aria-label": "Enter code",
      autocomplete: "one-time-code",
      inputmode: "numeric",
      maxlength: "6",
      pattern: "[0-9]*",
    });
    assert.deepEqual(onPage(GOOGLE_2SV, [totp]), [{ kind: "otp", label: "Enter code" }]);
    assert.equal(totp.mark(), "otp");

    // The same screen before Google set `autocomplete`: a short numeric box on
    // an auth origin is enough, and only there.
    const bare = element({
      type: "tel",
      name: "idvPin",
      "aria-label": "Enter code",
      maxlength: "6",
      autocomplete: "off",
    });
    assert.deepEqual(onPage(GOOGLE_2SV, [bare]), [{ kind: "otp", label: "Enter code" }]);
    assert.deepEqual(onPage(GMAIL_SEARCH, [bare]), []);
  });

  it("keeps the password rule, on any origin", () => {
    const google = element({
      type: "password",
      name: "Passwd",
      "aria-label": "Enter your password",
      autocomplete: "current-password",
    });
    assert.deepEqual(onPage(GOOGLE_2SV, [google]), [
      { kind: "password", label: "Enter your password" },
    ]);
    assert.equal(google.mark(), "password");

    const site = element({ type: "password", name: "password" });
    assert.deepEqual(onPage("https://example.com/account", [site]), [
      { kind: "password", label: "password" },
    ]);
    assert.equal(site.mark(), "password");
    // A secret contenteditable is still masked for capture, but it is not a
    // password field: only a real input/textarea credential control is.
    const box = element({ class: "secret" }, "true");
    assert.deepEqual(onPage("https://example.com/", [box]), []);
    assert.equal(box.mark(), "otp");
  });

  it("believes a field that names itself, and forgets one that stops matching", () => {
    // `name="otp"` is the element saying so; a bank does not use /login for it.
    const named = element({ type: "text", name: "otp", "aria-label": "One-time passcode" });
    assert.deepEqual(onPage("https://bank.example.com/transfer", [named]), [
      { kind: "otp", label: "One-time passcode" },
    ]);

    const renamed = element({ type: "text", name: "q", "data-modelbot-secret": "otp" });
    assert.deepEqual(onPage(GMAIL_SEARCH, [renamed]), []);
    assert.equal(renamed.mark(), null, "a stale mark keeps a page sensitive forever");
  });
});

it("hands the page straight back when a person says the ask was not needed", async () => {
  const state = createState("shell");
  const asked = await dispatch(state, {
    jsonrpc: "2.0",
    id: 1,
    method: "request_takeover",
    params: { reason: "otp_field", category: "sensitive" },
  });
  assert.equal(asked.ok, true);
  if (!asked.ok) return;
  const request = asked.data as { state: string; reason: string; field: unknown };
  assert.equal(request.state, "requested");
  assert.equal(request.reason, "otp_field", "the person is told why they were asked");
  assert.equal(request.field, null, "no page, so nothing to name");

  const declined = await dispatch(state, {
    jsonrpc: "2.0",
    id: 2,
    method: "takeover.decline",
    params: { takeover_id: state.takeover.takeoverId },
  });
  assert.equal(declined.ok, true);
  assert.equal(state.takeover.state, "agent");
  assert.equal(state.takeover.reason, null);

  // Control is back: the model's next call is not refused as busy.
  const after = await dispatch(state, {
    jsonrpc: "2.0",
    id: 3,
    method: "files_list",
    params: { path: "/workspace" },
  });
  assert.notEqual(after.ok === false && after.error.code, "E_TAKEOVER_BUSY");
});

const hasChromium = await chromiumAvailable().catch(() => false);

describe("what the snapshot tells the daemon", () => {
  it(
    "counts a sign-in page's fields and a mail page's none",
    { skip: !hasChromium && "Host Chromium unavailable" },
    async (t) => {
      process.env.MODELBOT_WORKSPACE = mkdtempSync(join(tmpdir(), "mb-secret-ws-"));
      process.env.MODELBOT_PROFILE = mkdtempSync(join(tmpdir(), "mb-secret-pf-"));
      process.env.MODELBOT_QUARANTINE = mkdtempSync(join(tmpdir(), "mb-secret-q-"));
      process.env.MODELBOT_PROXY_SERVER = "http://127.0.0.1:9";
      process.env.MODELBOT_PROXY_BYPASS = "127.0.0.1";
      const fixture = createServer((req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end(
          req.url?.startsWith("/signin")
            ? '<html><body><input type="password" name="Passwd" autocomplete="current-password">' +
              '<input type="tel" name="idvPin" aria-label="Enter code" maxlength="6"></body></html>'
            : req.url?.startsWith("/account")
              ? '<html><body><input inputmode="numeric" maxlength="6" placeholder="Enter code" ' +
                'value="220913"></body></html>'
              : '<html><body><input name="q" aria-label="Search mail" type="text">' +
                '<input name="mpp" inputmode="numeric" maxlength="3"></body></html>',
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

      assert.match(await snapshot("/signin"), /^modelbot_sensitive_fields: 2 password,otp\n/);
      // A code box on an ordinary page: masked in the snapshot, but not a
      // reason to stop and ask, so the header stays off.
      const account = await snapshot("/account");
      assert.doesNotMatch(account, /modelbot_sensitive_fields/);
      assert.doesNotMatch(account, /220913/, "a typed code reached the model transcript");
      assert.match(account, /"\*\*\*"/);
      assert.doesNotMatch(
        await snapshot("/mail"),
        /modelbot_sensitive_fields/,
        "a mailbox is not a login, and the daemon reads this line to decide",
      );

      // The ask a person answers names the field the page put on screen.
      await dispatch(state, {
        jsonrpc: "2.0",
        id: 3,
        method: "browser_navigate",
        params: { url: `http://127.0.0.1:${address.port}/signin`, wait_until: "load" },
      });
      const asked = await dispatch(state, {
        jsonrpc: "2.0",
        id: 4,
        method: "request_takeover",
        params: { reason: "otp_field", category: "sensitive" },
      });
      assert.equal(asked.ok, true);
      if (!asked.ok) return;
      assert.deepEqual((asked.data as { field: SensitiveField }).field, {
        kind: "password",
        label: "Passwd",
      });
      assert.equal((asked.data as { reason: string }).reason, "otp_field");

      const declined = await dispatch(state, {
        jsonrpc: "2.0",
        id: 5,
        method: "takeover.decline",
        params: { takeover_id: state.takeover.takeoverId },
      });
      assert.equal(declined.ok, true);
      if (!declined.ok) return;
      const back = declined.data as { state: string; reason: string | null; field: unknown };
      assert.equal(back.state, "agent", "a declined ask must hand the page back to the model");
      assert.equal(back.reason, null);
      assert.equal(back.field, null);
    },
  );
});
