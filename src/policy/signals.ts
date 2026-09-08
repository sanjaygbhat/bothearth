/** Observed effect signals evaluated by the policy gate (not tool names). */

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

/** Accessible controls in an aria snapshot line: `- textbox "Name" [ref=e1]`. */
function controls(yaml: string): { role: string; name: string }[] {
  return [...yaml.matchAll(/^\s*- (textbox|spinbutton|combobox|button|link) "((?:\\.|[^"\\])*)"/gm)]
    .map(([, role, name]) => ({ role: role!, name: name!.trim() }));
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
  const marked = header !== null || /data-modelbot-secret/.test(yaml);
  return {
    password_field: (marked && (kinds.length === 0 || kinds.includes("password")))
      || entries.some(({ name }) => /\bpass(?:word|phrase)\b/i.test(name)),
    otp_field: kinds.includes("otp") || entries.some(({ name }) => isCodeEntry(name)),
    webauthn_prompt: named.some(({ name }) => /\b(?:security key|passkey|windows hello|touch id)\b/i.test(name)),
    captcha_iframes:
      text.match(/https?:[^"\s]*(?:recaptcha|hcaptcha|turnstile|arkose)[^"\s]*/g) ?? [],
    payment_field: paymentField,
    checkout_path: checkoutPath,
  };
}
