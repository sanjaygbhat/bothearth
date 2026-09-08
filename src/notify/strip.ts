/**
 * Strip model-authored URLs from notify bodies (DECISIONS R2).
 * Operator-supplied URLs (e.g. takeover link) are passed separately and kept.
 */
const URL_RE =
  /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi;

export function stripUrlsFromModelReason(text: string): string {
  return text
    .replace(URL_RE, "[url removed]")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Cap free-text so notify channels stay usable. */
export function capNotifyText(text: string, max = 280): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
