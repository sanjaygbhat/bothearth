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
 *
 * A field a person cannot see or type into is neither marked nor reported.
 * Autofill traps, `display:none` dialogs, zero-size `aria-hidden` inputs,
 * `left:-9999px` offscreen boxes, sub-8px targets and `pointer-events:none`
 * must not look like a login.
 *
 * Kind "password" is only an `input[type=password]` or an `input`/`textarea`
 * whose autocomplete is `current-password` or `new-password`. Kind "otp" is
 * only an `input` with `autocomplete=one-time-code` or the inputmode/name
 * patterns below. A contenteditable composer (`role=textbox`, autocomplete
 * off, accessible name "Chat with ChatGPT") is neither marked nor counted.
 * `[contenteditable]`, `[role=textbox]`, `[autocomplete]`, and
 * `[aria-label*=password]` do not produce a kind on their own; a secret
 * contenteditable or `[data-secret=true]` may still be masked for capture.
 */
export function markSecretFields(maskSelector: string): SensitiveField[] {
  const OTP_WORD = /\b(?:otp|one[-\s]?time|verification|2fa|mfa|passcode)\b/i;
  const AUTH_PATH =
    /(?:^|\/)(?:login|log-in|signin|sign-in|verify|verification|challenge|two-factor|2fa|2sv|mfa)(?:\/|$)/i;
  // Nested: Playwright ships this function as source; no module-scope helpers.
  const flagsOf = (el: HTMLElement) => {
    const out = {
      ok: false,
      connected: el.isConnected !== false,
      visible: true,
      sized: true,
      intersects: true,
      inViewport: false,
      pointer: true,
      box: null as { x: number; y: number; w: number; h: number } | null,
    };
    if (!out.connected) return out;
    if (typeof el.matches === "function" && el.matches(":disabled")) return out;
    if (typeof el.closest === "function" && el.closest("[hidden], [aria-hidden='true']")) {
      return out;
    }
    if (
      typeof el.checkVisibility === "function" &&
      !el.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
        contentVisibilityAuto: true,
      })
    ) {
      out.visible = false;
      return out;
    }
    if (typeof el.getBoundingClientRect === "function") {
      const box = el.getBoundingClientRect();
      out.box = {
        x: Math.round(box.x),
        y: Math.round(box.y),
        w: Math.round(box.width),
        h: Math.round(box.height),
      };
      out.sized = box.width >= 8 && box.height >= 8;
      if (!out.sized) return out;
      const view = document.defaultView;
      const viewW = view && typeof view.innerWidth === "number" ? view.innerWidth : 0;
      const viewH = view && typeof view.innerHeight === "number" ? view.innerHeight : 0;
      out.inViewport = box.right > 0 && box.bottom > 0 && box.left < viewW && box.top < viewH;
      const root = document.documentElement;
      const sx = view && typeof view.scrollX === "number" ? view.scrollX : 0;
      const sy = view && typeof view.scrollY === "number" ? view.scrollY : 0;
      const left = box.left + sx;
      const top = box.top + sy;
      const inDocument =
        left + box.width > 0 &&
        top + box.height > 0 &&
        left < (root.scrollWidth || 0) &&
        top < (root.scrollHeight || 0);
      out.intersects = out.inViewport || inDocument;
      if (!out.intersects) return out;
    }
    if (typeof getComputedStyle === "function" && getComputedStyle(el).pointerEvents === "none") {
      out.pointer = false;
      return out;
    }
    out.ok = true;
    return out;
  };
  let authPage = false;
  try {
    const url = new URL(location.href);
    authPage = /(?:^|\.)accounts\.google\.com$/i.test(url.hostname) || AUTH_PATH.test(url.pathname);
  } catch {
    /* about:blank has no origin, and no sign-in form either. */
  }

  const found: SensitiveField[] = [];
  const details: Record<string, unknown>[] = [];
  for (const node of document.querySelectorAll(
    'input,textarea,[contenteditable],[data-secret="true"]',
  )) {
    const el = node as HTMLElement;
    const flags = flagsOf(el);
    if (!flags.ok) {
      el.removeAttribute("data-modelbot-secret");
      continue;
    }
    const attr = (name: string) => (el.getAttribute(name) ?? "").trim();
    const autocomplete = attr("autocomplete").toLowerCase();
    const type = attr("type").toLowerCase();
    const maxLength = Number(attr("maxlength"));
    const tag = el.tagName.toLowerCase();
    const isInput = tag === "input";
    const isTextarea = tag === "textarea";
    const label =
      attr("aria-label") || attr("name") || attr("id") || attr("placeholder") || type || tag;
    const password =
      (isInput && type === "password") ||
      ((isInput || isTextarea) &&
        (autocomplete.startsWith("current-password") || autocomplete.startsWith("new-password")));
    // A short numeric or telephone box: the shape a code goes in.
    const codeShaped =
      isInput &&
      (attr("inputmode").toLowerCase() === "numeric" || type === "tel") &&
      maxLength >= 1 &&
      maxLength <= 8;
    const otp =
      isInput &&
      (autocomplete.startsWith("one-time-code") ||
        OTP_WORD.test(`${attr("name")} ${attr("id")} ${attr("aria-label")}`) ||
        (authPage && codeShaped));
    const kind = password ? "password" : otp ? "otp" : null;
    const maskOnly =
      codeShaped ||
      (isInput && OTP_WORD.test(attr("placeholder"))) ||
      attr("data-secret") === "true" ||
      (el.isContentEditable && el.classList.contains("secret"));
    if (!kind && !maskOnly) {
      el.removeAttribute("data-modelbot-secret");
      continue;
    }
    el.setAttribute("data-modelbot-secret", kind ?? "otp");
    if (kind) {
      found.push({ kind, label: label.slice(0, 60) });
      const name = (attr("name") || attr("aria-label") || attr("placeholder")).slice(0, 40);
      const row: Record<string, unknown> = {
        tag: el.tagName.toLowerCase(),
        name,
        inViewport: flags.inViewport,
        connected: flags.connected,
        visible: flags.visible,
        sized: flags.sized,
        intersects: flags.intersects,
        pointer: flags.pointer,
      };
      if (type) row.type = type;
      if (flags.box) row.rect = flags.box;
      details.push(row);
    }
  }

  let style = document.getElementById("modelbot-secret-mask");
  if (!style) {
    style = document.createElement("style");
    style.id = "modelbot-secret-mask";
    document.documentElement.appendChild(style);
  }
  style.textContent = `${maskSelector}{color:transparent!important;text-shadow:none!important;background:#111!important;caret-color:transparent!important}`;
  if (typeof style.setAttribute === "function") {
    const max = details.slice(0, 5);
    while (max.length && JSON.stringify(max).length > 400) max.pop();
    const json = JSON.stringify(max);
    if (json.length > 2 && json.length <= 400) style.setAttribute("data-modelbot-detail", json);
    else style.removeAttribute("data-modelbot-detail");
  }
  return found;
}
