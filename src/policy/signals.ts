/** Observed effect signals evaluated by the policy gate (not tool names). */

export type SecretBranch = "header" | "marker" | "name";

/** Compact descriptor of a field that armed password/otp (≤5, JSON ≤400 chars). */
export interface SecretFieldEvidence {
  branch: SecretBranch;
  tag?: string;
  type?: string;
  name?: string;
  role?: string;
  kind?: "password" | "otp";
  rect?: { x: number; y: number; w: number; h: number };
  inViewport?: boolean;
  connected?: boolean;
  visible?: boolean;
  sized?: boolean;
  intersects?: boolean;
  pointer?: boolean;
}

export interface EffectSignals {
  password_field?: boolean;
  otp_field?: boolean;
  webauthn_prompt?: boolean;
  /** Frame origins matching captcha widgets. */
  captcha_iframes?: string[];
  payment_field?: boolean;
  checkout_path?: boolean;
  /** Destination origin when a form submit / Enter is about to fire. */
  form_submit_origin?: string | null;
  file_upload?: boolean;
  external_send?: boolean;
  delete?: boolean;
  /** Offending secret fields when password_field / otp_field is a hold. */
  secret_evidence?: SecretFieldEvidence[];
}

export const CAPTCHA_ORIGIN_MARKERS = [
  "google.com/recaptcha",
  "recaptcha",
  "gstatic.com/recaptcha",
  "hcaptcha.com",
  "js.hcaptcha.com",
  "challenges.cloudflare.com",
  "cf-turnstile",
  "arkoselabs.com",
  "funcaptcha",
] as const;

export function hasCaptchaSignal(signals: EffectSignals): boolean {
  if (!signals.captcha_iframes?.length) return false;
  return signals.captcha_iframes.some((o) =>
    CAPTCHA_ORIGIN_MARKERS.some((m) => o.toLowerCase().includes(m)),
  );
}

export function hasSecretEntrySignal(signals: EffectSignals): boolean {
  return Boolean(
    signals.password_field || signals.otp_field || signals.webauthn_prompt,
  );
}

export function hasPaymentSignal(signals: EffectSignals): boolean {
  return Boolean(signals.payment_field || signals.checkout_path);
}

/** Accessible controls in an aria snapshot line: `- textbox "Name" [active] [ref=e1]`. */
function controls(yaml: string): { role: string; name: string; active: boolean }[] {
  return [
    ...yaml.matchAll(
      /^\s*- (textbox|spinbutton|combobox|button|link) "((?:\\.|[^"\\])*)"([^\n]*)/gm,
    ),
  ].map(([, role, name, rest]) => ({
    role: role!,
    name: name!.trim(),
    active: /\[active\]/.test(rest ?? ""),
  }));
}

const DETAIL_STRINGS = ["tag", "type", "name", "role"] as const;
const DETAIL_FLAGS = [
  "inViewport",
  "connected",
  "visible",
  "sized",
  "intersects",
  "pointer",
] as const;

function capStr(value: unknown, max = 40): string | undefined {
  return typeof value === "string" && value ? value.slice(0, max) : undefined;
}

function copyFlags(src: Record<string, unknown>, out: Partial<SecretFieldEvidence>): void {
  for (const key of DETAIL_FLAGS) {
    if (typeof src[key] === "boolean") out[key] = src[key];
  }
}

/** Keep tag/type/name/role/rect/flags/branch/kind; drop unknown keys (including value). */
export function sanitizeSecretEvidenceRow(raw: unknown): Partial<SecretFieldEvidence> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: Partial<SecretFieldEvidence> = {};
  for (const key of DETAIL_STRINGS) {
    const value = capStr(src[key]);
    if (value) out[key] = value;
  }
  if (src.kind === "password" || src.kind === "otp") out.kind = src.kind;
  if (src.branch === "header" || src.branch === "marker" || src.branch === "name") {
    out.branch = src.branch;
  }
  if (src.rect && typeof src.rect === "object" && !Array.isArray(src.rect)) {
    const box = src.rect as Record<string, unknown>;
    const rect: SecretFieldEvidence["rect"] = { x: 0, y: 0, w: 0, h: 0 };
    let ok = true;
    for (const key of ["x", "y", "w", "h"] as const) {
      if (typeof box[key] !== "number" || !Number.isFinite(box[key])) {
        ok = false;
        break;
      }
      rect[key] = box[key];
    }
    if (ok) out.rect = rect;
  }
  copyFlags(src, out);
  if (src.flags && typeof src.flags === "object" && !Array.isArray(src.flags)) {
    copyFlags(src.flags as Record<string, unknown>, out);
  }
  return Object.keys(out).length ? out : undefined;
}

function capEvidence(fields: SecretFieldEvidence[]): SecretFieldEvidence[] | undefined {
  const max = fields.slice(0, 5);
  while (max.length && JSON.stringify(max).length > 400) max.pop();
  return max.length ? max : undefined;
}

function parseMarkedDetail(yaml: string): Omit<SecretFieldEvidence, "branch">[] {
  const line = /^modelbot_sensitive_detail:[ \t]*([^\n]*)/m.exec(yaml);
  if (!line) return [];
  try {
    const parsed: unknown = JSON.parse(line[1]!.slice(0, 400));
    if (!Array.isArray(parsed)) return [];
    const rows: Omit<SecretFieldEvidence, "branch">[] = [];
    for (const item of parsed.slice(0, 5)) {
      const row = sanitizeSecretEvidenceRow(item);
      if (!row) continue;
      const rest = { ...row };
      delete rest.branch;
      if (Object.keys(rest).length) rows.push(rest);
    }
    return rows;
  } catch {
    return [];
  }
}

const ENTRY_ROLES = new Set(["textbox", "spinbutton", "combobox"]);
const CODE_QUALIFIER = /^(?:2-step|two-step|sms|one-time|verification|security|authentication|confirmation)$/i;

/** "Enter code", "2-step verification code", "one-time password" — not "Search mail". */
function isCodeEntry(name: string): boolean {
  const words = name
    .replace(/^(?:enter|type)\s+/i, "")
    .replace(/^(?:your|the)\s+/i, "")
    .replace(/one[-\s]time/i, "one-time")
    .split(/\s+/)
    .filter(Boolean);
  const noun = words.pop()?.toLowerCase();
  if (!noun || !/^(?:code|otp|passcode|pin|password)$/.test(noun)) return false;
  if (noun === "password" && words.length === 0) return false;
  return words.every((word) => CODE_QUALIFIER.test(word));
}

// ponytail: snapshot text heuristics; use structured browser signals when available.
export function signalsFromObservation(value: unknown): EffectSignals {
  const text = (JSON.stringify(value) ?? "").toLowerCase();
  const data = (value as { data?: { url?: unknown; yaml?: unknown } } | null)?.data;
  const yaml = typeof data?.yaml === "string" ? data.yaml : "";
  // Match accessible control names, never surrounding prose or input values.
  // A mailbox listing "Your verification code" or "Reset your password" is
  // prose about a login, not a login: reading it must not stop the task and
  // ask a person for a screen that is not there.
  const named = controls(yaml);
  const paymentField = named.some(({ role, name }) => role === "button" || role === "link"
      ? /^(?:confirm payment|payment confirm(?:ation)?)(?:\s+\(?\p{Sc}?\s*\d[\d.,]*(?:\s+[A-Z]{3})?\)?)?$/iu.test(name)
      : /card number|card details|payment confirm|confirm payment/i.test(name));
  const entries = named.filter(({ role }) => ENTRY_ROLES.has(role));
  let checkoutPath = false;
  if (typeof data?.url === "string") {
    try {
      const url = new URL(data.url);
      checkoutPath = /\/(?:checkout|pay)(?:\/|$)/i.test(url.pathname)
        || /^#!?\/(?:checkout|pay)(?:[/?]|$)/i.test(url.hash);
    } catch { /* Invalid observation URLs do not identify checkout routes. */ }
  }
  // The container counts the real secret inputs it masked (`input[type=password]`,
  // `autocomplete=one-time-code`, …) and names their kinds; that header, not the
  // words on the page, is what says a credential can be typed here. An older
  // computer-server sends the count alone — read that as a password field, which
  // is the stricter of the two gates.
  const header = /^modelbot_sensitive_fields:[ \t]*[1-9]\d*[ \t]*([^\n]*)/m.exec(yaml);
  const kinds = header ? header[1]!.trim().split(",").filter(Boolean) : [];
  const marker = /data-modelbot-secret/.test(yaml);
  const marked = header !== null || marker;
  const namedPassword = entries.filter(({ name }) => /\bpass(?:word|phrase)\b/i.test(name));
  // A real, visible password input is always marked by redact.ts, so the name
  // heuristic alone is only reached for unmarked (invisible or non-input)
  // matches. A name match is a hold only if that entry is focused or a marked
  // field exists; otherwise it is a hint.
  const nameHold =
    namedPassword.some((entry) => entry.active) || (marked && namedPassword.length > 0);
  const passwordField = (marked && (kinds.length === 0 || kinds.includes("password"))) || nameHold;
  const namedOtp = entries.filter(({ name }) => isCodeEntry(name));
  const otpField = kinds.includes("otp") || namedOtp.length > 0;
  const branch: SecretBranch | undefined = header
    ? "header"
    : marker
      ? "marker"
      : nameHold || namedOtp.length > 0
        ? "name"
        : undefined;
  let secret_evidence: SecretFieldEvidence[] | undefined;
  if (passwordField || otpField) {
    if (branch === "name") {
      const heldPassword = namedPassword.filter((entry) => entry.active);
      const rows = [...heldPassword, ...namedOtp].map((entry) => ({
        branch: "name" as const,
        name: entry.name.slice(0, 40),
        role: entry.role,
      }));
      secret_evidence = capEvidence(rows);
    } else if (branch) {
      const markedRows = parseMarkedDetail(yaml).map((row) => ({ ...row, branch }));
      secret_evidence = capEvidence(markedRows.length ? markedRows : [{ branch }]);
    }
  }
  return {
    password_field: passwordField,
    otp_field: otpField,
    webauthn_prompt: named.some(({ name }) => /\b(?:security key|passkey|windows hello|touch id)\b/i.test(name)),
    captcha_iframes:
      text.match(/https?:[^"\s]*(?:recaptcha|hcaptcha|turnstile|arkose)[^"\s]*/g) ?? [],
    payment_field: paymentField,
    checkout_path: checkoutPath,
    ...(secret_evidence ? { secret_evidence } : {}),
  };
}
