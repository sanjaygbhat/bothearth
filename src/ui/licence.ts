import { apiGet, apiPost, ApiError } from "./api.ts";
import { appendTextChild, element } from "./safe.ts";
import { refreshSession, type LicenceInfo } from "./session.ts";

/** Only public licence metadata reaches the UI; certificates stay in the paste field/request. */
function metadata(value: unknown): LicenceInfo | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (!["legacy", "unlicensed", "active"].includes(String(item.status)) || typeof item.required !== "boolean"
    || typeof item.label !== "string" || !item.label.trim() || item.label.length > 160) return null;
  return {
    status: item.status as LicenceInfo["status"], required: item.required, label: item.label.trim(),
    ...(typeof item.covered_release === "string" && item.covered_release.length <= 160 ? { covered_release: item.covered_release } : {}),
    ...(typeof item.account_url === "string" && item.account_url.length <= 2048 ? { account_url: item.account_url } : {}),
    ...(item.tier === "noncommercial" || item.tier === "commercial" ? { tier: item.tier } : {}),
  };
}

export function publishLicenceBadge(value: unknown): void {
  const licence = metadata(value);
  const badge = document.getElementById("tb-licence");
  if (!badge) return;
  badge.hidden = !licence || licence.status === "legacy";
  badge.textContent = licence?.status === "unlicensed" ? "Add key" : licence?.label ?? "";
  badge.setAttribute("aria-label", `${licence?.label ?? "Licence"}. Open licence settings.`);
  const titlebar = document.getElementById("titlebar");
  if (!badge.hidden) titlebar?.setAttribute("data-licence", "");
  else titlebar?.removeAttribute("data-licence");
}

function accountLink(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return !url.username && !url.password && (url.protocol === "https:" || local) ? url.href : null;
  } catch { return null; }
}

export function renderLicence(pane: HTMLElement): () => void {
  let disposed = false;
  let busy = false;
  let revision = 0;
  const live = () => !disposed && pane.isConnected;
  appendTextChild(pane, "h3", "Licence");
  const state = appendTextChild(pane, "p", "Checking your licence…", "set-lede");
  const detail = appendTextChild(pane, "p", "", "set-note");
  const account = element("a", "btn", "Get free key");
  account.target = "_blank";
  account.rel = "noopener noreferrer";
  account.hidden = true;
  const actions = element("div", "set-actions");
  actions.append(account);
  pane.append(actions);

  const form = element("form", "set-licence-form");
  form.setAttribute("autocomplete", "off");
  form.hidden = true;
  const field = element("label", "set-field", "Licence key");
  const key = element("input");
  key.type = "password";
  key.maxLength = 8192;
  key.setAttribute("autocomplete", "off");
  key.setAttribute("spellcheck", "false");
  key.setAttribute("aria-describedby", "licence-key-note");
  field.append(key);
  const note = element("p", "set-note", "Paste the key from your BotHearth account.");
  note.id = "licence-key-note";
  const submit = element("button", "btn primary", "Activate");
  submit.type = "submit";
  submit.disabled = true;
  const submitRow = element("div", "set-actions");
  submitRow.append(submit);
  form.append(field, note, submitRow);
  pane.append(form);
  const message = appendTextChild(pane, "p", "", "set-msg");
  message.setAttribute("role", "status");
  const retry = element("button", "btn sm", "Try again");
  retry.type = "button";
  retry.hidden = true;
  pane.append(retry);

  const paint = (licence: LicenceInfo) => {
    state.textContent = licence.label;
    detail.textContent = licence.status === "legacy"
      ? "This release keeps its existing licence terms. No key is required."
      : [licence.covered_release ? `Covers release ${licence.covered_release}.` : "",
        licence.status === "unlicensed" ? licence.required ? "Add your key to start tasks." : "You can add a key for this release."
          : "Your key is active on this installation."].filter(Boolean).join(" ");
    const href = accountLink(licence.account_url);
    account.hidden = !href || licence.status === "legacy";
    if (href) account.href = href;
    else account.removeAttribute("href");
    account.textContent = licence.status === "active" ? "Manage keys" : "Get free key";
    form.hidden = licence.status === "legacy";
    publishLicenceBadge(licence);
  };
  const refresh = async () => {
    const request = ++revision;
    retry.hidden = true;
    try {
      const result = metadata(await apiGet("/api/v1/licence"));
      if (!live() || request !== revision) return;
      if (!result) throw new Error("Invalid licence metadata");
      paint(result);
    } catch (error) {
      if (!live() || request !== revision) return;
      state.textContent = error instanceof ApiError && error.status === 404
        ? "Licence settings need an app update." : "Couldn’t read your licence. Try again.";
      retry.hidden = false;
    }
  };

  key.addEventListener("input", () => { submit.disabled = busy || !key.value.trim(); });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || form.hidden) return;
    const certificate = key.value.trim();
    key.value = "";
    submit.disabled = true;
    if (!certificate || certificate.length > 8192) {
      message.dataset.tone = "danger";
      message.textContent = "Paste a complete licence key of up to 8,192 characters.";
      return;
    }
    busy = true;
    const request = ++revision;
    key.disabled = true;
    submit.textContent = "Activating…";
    message.textContent = "";
    void apiPost("/api/v1/licence/activate", { certificate }).then((response) => {
      if (!live() || request !== revision) return;
      const result = metadata(response);
      if (!result) throw new Error("Invalid licence metadata");
      paint(result);
      message.dataset.tone = "ok";
      message.textContent = "Licence activated.";
      window.dispatchEvent(new Event("bothearth:licence-changed"));
      void refreshSession().then((session) => {
        if (live() && request === revision && session?.licence) publishLicenceBadge(session.licence);
      }).catch(() => { /* Keep the confirmed licence if session refresh fails. */ });
    }).catch(() => {
      if (!live() || request !== revision) return;
      message.dataset.tone = "danger";
      // Do not echo a server error that might contain the pasted certificate.
      message.textContent = "Couldn’t activate this key. Check that it covers this release, then paste it again.";
    }).finally(() => {
      if (!live() || request !== revision) return;
      busy = false;
      key.disabled = false;
      submit.textContent = "Activate";
      submit.disabled = !key.value.trim();
    });
  });
  retry.addEventListener("click", () => { void refresh(); });
  const clearKey = () => { key.value = ""; submit.disabled = true; };
  window.addEventListener("pagehide", clearKey);
  void refresh();
  return () => {
    disposed = true;
    clearKey();
    message.textContent = "";
    window.removeEventListener("pagehide", clearKey);
  };
}
