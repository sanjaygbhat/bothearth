/** What counts as a credential field, and how one is kept out of a capture. */

const TOKEN_QUERY =
  /([?&#](?:token|access_token|id_token|refresh_token|code|auth|session|sid|key|secret|password|credential)=)[^&\s"'`]+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;

export function redactUrl(url: string): string {
  return url.replace(TOKEN_QUERY, "$1REDACTED").replace(BEARER, "Bearer REDACTED");
}

export function redactSnapshotYaml(yaml: string): string {
  return yaml
    .split("\n")
    .map((line) => {
      let s = line;
      const secretish =
        /\bpassword\b/i.test(s) ||
        /\bone-?time(?:\s|-)?code\b/i.test(s) ||
        /\botp\b/i.test(s) ||
        /inputmode[=:\s]+numeric/i.test(s) ||
        /autocomplete[=:\s]+[^\s]*one-time-code/i.test(s) ||
        (/\bcontenteditable\b/i.test(s) && /\bsecret\b/i.test(s));
      if (secretish) {
        s = s.replace(/:\s*".*"/, ': "***"');
        s = s.replace(/\bvalue=[^\s\]]+/i, "value=***");
      }
      return redactUrl(s);
    })
    .join("\n");
}

/** A credential field `markSecretFields` found, named by what the page calls it. */
export interface SensitiveField {
  kind: "password" | "otp";
  label: string;
}

/** Pre-capture mask selector: exactly what `markSecretFields` marked. */
export const SECRET_MASK_SELECTORS = "[data-modelbot-secret]";

/**
 * Marks every credential field on the page, blacks them out for capture, and
 * reports what it marked. Runs inside the page — Playwright ships it as source,
 * so it must stay self-contained: no imports, no module-scope references.
 *
 * Masking and asking are two different questions. A short numeric box or a box
 * whose placeholder says "code" is masked wherever it appears, because hiding a
 * value costs nothing and a typed OTP must never reach the transcript. It is
 * only *reported* — and so only stops the task to ask for a person — where the
 * element itself says what it is, or a sign-in actually happens: marking
 * `input[inputmode="numeric"]` as an OTP ask everywhere parked a real Gmail
 * task on "there's a code from your phone to type in" for three and a half
 * minutes with no code on screen.
 */
export function markSecretFields(maskSelector: string): SensitiveField[] {
  const OTP_WORD = /\b(?:otp|one[-\s]?time|verification|2fa|mfa|passcode)\b/i;
  const AUTH_PATH =
    /(?:^|\/)(?:login|log-in|signin|sign-in|verify|verification|challenge|two-factor|2fa|2sv|mfa)(?:\/|$)/i;
  let authPage = false;
  try {
    const url = new URL(location.href);
    authPage =
      /(?:^|\.)accounts\.google\.com$/i.test(url.hostname) || AUTH_PATH.test(url.pathname);
  } catch {
    /* about:blank has no origin, and no sign-in form either. */
  }

  const found: SensitiveField[] = [];
  for (const node of document.querySelectorAll(
    'input,textarea,[contenteditable],[data-secret="true"]',
  )) {
    const el = node as HTMLElement;
    const attr = (name: string) => (el.getAttribute(name) ?? "").trim();
    const autocomplete = attr("autocomplete").toLowerCase();
    const type = attr("type").toLowerCase();
    const maxLength = Number(attr("maxlength"));
    const label =
      attr("aria-label") || attr("name") || attr("id") || attr("placeholder") || type ||
      el.tagName.toLowerCase();
    const password =
      type === "password" ||
      autocomplete.startsWith("current-password") ||
      autocomplete.startsWith("new-password") ||
      attr("data-secret") === "true" ||
      (el.isContentEditable && (el.classList.contains("secret") || el.hasAttribute("autocomplete")));
    // A short numeric or telephone box: the shape a code goes in.
    const codeShaped =
      (attr("inputmode").toLowerCase() === "numeric" || type === "tel") &&
      maxLength >= 1 &&
      maxLength <= 8;
    const otp =
      autocomplete.startsWith("one-time-code") ||
      OTP_WORD.test(`${attr("name")} ${attr("id")} ${attr("aria-label")}`) ||
      (authPage && codeShaped);
    const kind = password ? "password" : otp ? "otp" : null;
    if (!kind && !codeShaped && !OTP_WORD.test(attr("placeholder"))) {
      el.removeAttribute("data-modelbot-secret");
      continue;
    }
    el.setAttribute("data-modelbot-secret", kind ?? "otp");
    if (kind) found.push({ kind, label: label.slice(0, 60) });
  }

  let style = document.getElementById("modelbot-secret-mask");
  if (!style) {
    style = document.createElement("style");
    style.id = "modelbot-secret-mask";
    document.documentElement.appendChild(style);
  }
  style.textContent = `${maskSelector}{color:transparent!important;text-shadow:none!important;background:#111!important;caret-color:transparent!important}`;
  return found;
}
