import { originMatchesPattern } from "../protocol/origin.ts";
import type { Mode, PolicyGate, ToolName } from "../types/contracts.ts";
import type { CategoriesFile } from "./categories.ts";
import type { EffectSignals } from "./signals.ts";
import { loadTosRisk, matchTosRisk, type TosRiskFile } from "./tos.ts";

export type GateDecision =
  | { decision: "allow" }
  | {
      decision: "require_approval";
      reason: string;
      gate: PolicyGate;
      /**
       * The origin this gate is about, when the answer is a decision about a
       * site: approving it may be remembered for that origin. Absent on the
       * gates that are about the action rather than the site — payment,
       * delete, upload, external send, secret entry — which are asked every
       * time however well known the site is.
       */
      origin?: string;
    }
  | { decision: "deny"; reason: string };

export interface OriginSets {
  readable: string[];
  writable: string[];
}

export interface ToolCall {
  tool: ToolName;
  args: Record<string, unknown>;
}

export interface GateContext {
  call: ToolCall;
  signals: EffectSignals;
  /** Current top-level page origin. */
  origin: string;
  mode: Mode;
  origin_sets: OriginSets;
  categories?: CategoriesFile;
  tos?: TosRiskFile;
  kill_switch?: boolean;
  /** Typed override for tos-risk `block` entries. */
  typed_tos_override?: boolean;
  /**
   * Optional approval classes that may return `require_approval`. Omitted = all
   * armed (matching tests). Empty = none of them fire. kill_switch / ToS deny
   * are not in this list and always evaluate.
   */
  enabled_gates?: readonly PolicyGate[];
}

/** Tools that can produce the same user-visible effect as each other. */
const EQUIVALENT_ACT_TOOLS: ReadonlySet<ToolName> = new Set([
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_select",
  "computer_mouse",
  "computer_key",
  "computer_type",
]);

const READ_TOOLS: ReadonlySet<ToolName> = new Set([
  "browser_snapshot",
  "browser_screenshot",
  "browser_wait",
  "files_list",
  "files_read",
  "takeover_status",
  "done",
  "request_takeover",
]);

function originInSet(origin: string, set: string[]): boolean {
  if (set.length === 0) return false;
  return set.some((p) => originMatchesPattern(origin, p));
}

function normalizeOrigin(origin: string): string {
  try {
    if (origin.includes("://")) return new URL(origin).origin;
  } catch {
    /* fall through */
  }
  return origin;
}

/** Infer additive effect flags from the tool call itself. */
export function inferSignalsFromCall(
  call: ToolCall,
  base: EffectSignals = {},
): EffectSignals {
  const out: EffectSignals = { ...base };
  const { tool, args } = call;

  if (tool === "browser_upload" || out.file_upload) {
    out.file_upload = true;
  }
  if (tool === "files_delete") {
    out.delete = true;
  }
  if (tool === "shell_exec") {
    const cmd = String(args.command ?? "");
    if (/\b(rm|unlink|del|Remove-Item|shred)\b/i.test(cmd)) out.delete = true;
    if (/\b(curl|wget|mail|sendmail|nc|ncat|scp|rsync)\b/i.test(cmd)) {
      out.external_send = true;
    }
  }
  if (tool === "connector_call") {
    const t = String(args.tool ?? "").toLowerCase();
    if (/(send|mail|message|post|publish|tweet)/.test(t)) out.external_send = true;
    if (/(delete|remove|destroy)/.test(t)) out.delete = true;
  }
  if (tool === "browser_tabs") {
    const action = String(args.action ?? "");
    if (action === "close") out.delete = true;
  }

  // Form submit / Enter — shared across equivalent primitives
  if (tool === "browser_type" && args.submit === true) {
    out.form_submit_origin = out.form_submit_origin ?? null;
  }
  if (
    (tool === "browser_press" || tool === "computer_key") &&
    isEnterKey(String(args.key ?? ""))
  ) {
    out.form_submit_origin =
      out.form_submit_origin === undefined ? null : out.form_submit_origin;
  }
  if (tool === "computer_type" && /\n$/.test(String(args.text ?? ""))) {
    out.form_submit_origin =
      out.form_submit_origin === undefined ? null : out.form_submit_origin;
  }

  return out;
}

function isEnterKey(key: string): boolean {
  const k = key.toLowerCase();
  return k === "enter" || k === "return" || k === "numpadenter";
}

function isActLike(tool: ToolName): boolean {
  return (
    EQUIVALENT_ACT_TOOLS.has(tool) ||
    tool === "browser_upload" ||
    tool === "browser_navigate"
  );
}

/**
 * Evaluate a tool call against observed effect signals + origin sets.
 * Equivalent primitives share this gate (click / press / coords / type).
 */
export function evaluateGate(ctx: GateContext): GateDecision {
  if (ctx.kill_switch) {
    return { decision: "deny", reason: "kill_switch" };
  }

  const tos = ctx.tos ?? loadTosRisk();
  const signals = inferSignalsFromCall(ctx.call, ctx.signals);
  const origin = normalizeOrigin(ctx.origin);
  const tool = ctx.call.tool;

  if (
    tool === "browser_tabs" &&
    (ctx.call.args.action === "list" || ctx.call.args.action === "select")
  ) {
    return { decision: "allow" };
  }

  // ToS block — needs typed override
  const tosHit = matchTosRisk(origin, tos);
  if (tosHit?.risk === "block" && isActLike(tool) && !READ_TOOLS.has(tool)) {
    if (!ctx.typed_tos_override) {
      return {
        decision: "deny",
        reason: `tos_block:${tosHit.id}`,
      };
    }
  }

  if (READ_TOOLS.has(tool)) {
    return { decision: "allow" };
  }

  // write_file saves a deliverable into the task's own /workspace/out. Nothing
  // leaves the machine, nothing existing is deleted, no third party is contacted,
  // and the computer-server confines the path to that one directory — so none of
  // the effects this gate exists to catch (external_send, delete, upload, payment,
  // new-origin submit) can arise. Approving it would train the human to click
  // through the prompt that guards the calls that DO send data outward.
  if (tool === "write_file") {
    return { decision: "allow" };
  }

  // Opening a page is ordinary task work. It does not grant permission to
  // submit a form, upload files or send data; those effects are checked below.
  if (tool === "browser_navigate" || (tool === "browser_tabs" && ctx.call.args.action === "new")) {
    const dest = normalizeOrigin(String(ctx.call.args.url ?? "about:blank"));
    if (ctx.mode === "strict" && dest !== "about:blank" && !originInSet(dest, ctx.origin_sets.writable)) {
      return { decision: "deny", reason: `strict_origin_denied:${dest}` };
    }
    return { decision: "allow" };
  }

  // Delete patterns
  if (signals.delete || tool === "files_delete") {
    const hit = approveOrDeny(ctx, "delete", "delete_pattern");
    if (hit) return hit;
  }

  // Upload
  if (signals.file_upload || tool === "browser_upload") {
    const hit = approveOrDeny(ctx, "upload", "file_upload");
    if (hit) return hit;
  }

  // External send
  if (signals.external_send) {
    const hit = approveOrDeny(ctx, "external_send", "external_send");
    if (hit) return hit;
  }

  // Checkout path: extra confirm if `payment` is armed. Card-field signals
  // still reach the observation; they do not mint a hold.
  if (signals.checkout_path) {
    const hit = approveOrDeny(ctx, "payment", "checkout_path");
    if (hit) return hit;
  }

  // Form submit / Enter to origin outside writable set
  if (signals.form_submit_origin !== undefined) {
    const dest = normalizeOrigin(signals.form_submit_origin ?? origin);
    if (!originInSet(dest, ctx.origin_sets.writable)) {
      const hit = approveOrDeny(
        ctx,
        "new_domain",
        `form_submit_new_origin:${dest}`,
        dest,
      );
      if (hit) return hit;
    }
  }

  // Strict: any act on non-writable current origin
  if (
    ctx.mode === "strict" &&
    isActLike(tool) &&
    !originInSet(origin, ctx.origin_sets.writable)
  ) {
    return { decision: "deny", reason: `strict_origin_denied:${origin}` };
  }

  // Secret entry via shell
  if (tool === "shell_exec") {
    const cmd = String(ctx.call.args.command ?? "");
    if (/\b(passwd|ssh-keygen|openssl|security\s+add)\b/i.test(cmd)) {
      const hit = approveOrDeny(ctx, "secret_entry", "shell_secret_pattern");
      if (hit) return hit;
    }
    const send = approveOrDeny(ctx, "external_send", "arbitrary_shell_command");
    if (send) return send;
    return { decision: "allow" };
  }

  if (tool === "connector_call") {
    const hit = approveOrDeny(ctx, "external_send", "unclassified_connector_effect");
    if (hit) return hit;
    return { decision: "allow" };
  }

  // Equivalent act primitives share the signal-based gates above. A plain
  // same-origin click/type without effect signals stays allow; form submit,
  // payment, upload, delete, and new-origin navigation are already covered.
  return { decision: "allow" };
}

function gateArmed(ctx: GateContext, gate: PolicyGate): boolean {
  return ctx.enabled_gates === undefined || ctx.enabled_gates.includes(gate);
}

function approveOrDeny(
  ctx: GateContext,
  gate: PolicyGate,
  reason: string,
  origin?: string,
): GateDecision | null {
  if (ctx.mode === "strict" && gate === "new_domain") {
    return { decision: "deny", reason };
  }
  if (!gateArmed(ctx, gate)) return null;
  return { decision: "require_approval", reason, gate, ...(origin ? { origin } : {}) };
}

/** Same gate for every equivalent primitive — used by tests / callers. */
export function evaluateEquivalent(
  tools: ToolName[],
  base: Omit<GateContext, "call"> & { args?: Record<string, unknown> },
): GateDecision[] {
  return tools.map((tool) =>
    evaluateGate({
      ...base,
      call: { tool, args: base.args ?? {} },
    }),
  );
}
