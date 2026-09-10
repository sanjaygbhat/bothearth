/**
 * Settings → Model connection.
 *
 * Two selectable rows — Claude Code and Codex — each showing what was actually
 * found, then one status line, one action, and the fine print.
 * Detection comes from `GET /api/v1/runtime` (the `ai` block) and
 * `GET /api/v1/connection`, which is also where every action posts back.
 *
 * Rules this file keeps:
 *   - opening Settings never signs anything in; a POST needs a click;
 *   - an explicit sign-in polls until the CLI reports `signed_in`, then
 *     connects exactly once;
 *   - the Codex device code is shown only for the official verification URL,
 *     a well-formed code and an unexpired challenge;
 *   - a detached pane cancels its timers and never navigates;
 *   - a CLI path, a provider id or a model string is never in the first line of
 *     a row. It lives behind "Details", and nowhere else.
 */

import { apiGet, apiPost } from "./api.ts";
import { publishStatusPill } from "./home.ts";
import { limitTime, type ProviderLimit } from "./runtime.ts";
import { appendTextChild } from "./safe.ts";

export type ConnectionStatus =
  | "connected"
  | "signed_in"
  | "signed_out"
  | "missing"
  | "signing_in"
  | "error";

export type Provider = "codex" | "claude";

export type Connection = {
  status: ConnectionStatus;
  login_mode?: "browser" | "device" | "terminal";
  execution_location?: "host" | "computer";
  computer_id?: string;
  device_auth?: { verification_uri: string; user_code: string; expires_at: string };
  native_terminal?: { output: string; can_reply: true };
  provider: Provider;
  model: string;
  message?: string;
  install_url?: string;
  /** Signed in and refusing. `status` stays `connected`; this says otherwise. */
  limit?: ProviderLimit | null;
};

/** The `ai` block of `GET /api/v1/runtime`. */
export type RuntimeAi = {
  provider: Provider | null;
  cli_found: boolean;
  cli_path_kind: "path" | "well-known" | null;
  logged_in: boolean | null;
  detail: string;
  limit?: ProviderLimit | null;
};

const PROVIDER_NAME: Record<Provider, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const PLAN_NAME: Record<Provider, string> = {
  claude: "your Claude plan",
  codex: "your ChatGPT plan",
};

const DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";
const DEVICE_CODE = /^[A-Z0-9]{4,5}-[A-Z0-9]{4,5}$/;
const POLL_MS = 1000;

/**
 * A CLI that is signed in and still turning tasks down. `codex login status`
 * exits 0 on a spent plan, so "Connected" was true and useless; this is the
 * sentence that replaces it.
 */
export function limitWord(limit: ProviderLimit | null | undefined): string | null {
  if (!limit) return null;
  const until = limitTime(limit.resets_at);
  const what = limit.reason === "quota_exhausted" ? "Plan limit reached" : "Turning tasks down";
  return until ? `${what} until ${until}` : what;
}

/**
 * The one line under a provider’s name. Plain English only: it says where the
 * app is and whether it is signed in, never where its binary lives.
 */
export function providerRowCopy(
  provider: Provider,
  connection: Connection | null,
  detected: boolean,
): string {
  if (!connection) return detected ? "Found" : "Checking connection";
  const found = connection.execution_location === "computer" ? "In the bot’s computer" : "Found";
  switch (connection.status) {
    case "connected":
      return [
        connection.execution_location === "computer" ? "Connected in the bot’s computer" : "Signed in as you",
        connection.model || null,
        limitWord(connection.limit) ?? `billed on ${PLAN_NAME[provider]}`,
      ]
        .filter(Boolean)
        .join(" · ");
    case "signed_in":
      return `${found} · signed in, not connected yet`;
    case "signing_in":
      return `${found} · signing in now`;
    case "signed_out":
      return `${found} · not signed in`;
    case "missing":
      return connection.execution_location === "computer" ? "Not in the bot’s computer yet" : "Not installed yet";
    default:
      return "Couldn’t check this one just now";
  }
}

/** "a moment ago" / "2 minutes ago" — never a raw timestamp. */
export function lastCheckedLabel(agoMs: number): string {
  if (agoMs < 45_000) return "a moment ago";
  const minutes = Math.round(agoMs / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

type Tone = "ok" | "run" | "warn" | "danger" | "neutral";

/** Dot + word for the status line, from the same state the rows read. */
export function statusTone(status: ConnectionStatus | null, limit?: ProviderLimit | null): Tone {
  switch (status) {
    case "connected":
      return limit ? "warn" : "ok";
    case "signing_in":
      return "run";
    case "signed_in":
      return "warn";
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}

export function statusWord(status: ConnectionStatus | null, limit?: ProviderLimit | null): string {
  switch (status) {
    case "connected":
      return limitWord(limit) ?? "Connected";
    case "signing_in":
      return "Signing in";
    case "signed_in":
      return "Signed in, not connected";
    case "signed_out":
      return "Not signed in";
    case "missing":
      return "Not installed";
    case "error":
      return "Couldn’t check";
    default:
      return "Checking";
  }
}

function https(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Render the Model connection section into `pane`. Returns a disposer that stops
 * every timer; call it before the pane is cleared.
 */
export function renderAiConnection(pane: HTMLElement): () => void {
  let disposed = false;
  const live = () => !disposed && pane.isConnected;

  appendTextChild(pane, "h3", "Model connection");
  appendTextChild(
    pane,
    "p",
    "Choose an account to run your tasks. Sign in with Codex or Claude Code.",
    "set-lede",
  );

  const group = document.createElement("div");
  group.className = "set-rows";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "Model provider");
  pane.append(group);

  const order: Provider[] = ["claude", "codex"];
  const rows = new Map<Provider, { button: HTMLElement; sub: HTMLElement }>();
  for (const provider of order) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "set-opt";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", "false");
    const radio = document.createElement("span");
    radio.className = "set-radio";
    const text = document.createElement("span");
    text.className = "set-grow";
    appendTextChild(text, "span", PROVIDER_NAME[provider], "set-n");
    const sub = appendTextChild(text, "span", "Checking connection", "set-w");
    button.append(radio, text);
    group.append(button);
    rows.set(provider, { button, sub });
  }

  const state = document.createElement("div");
  state.className = "set-state";
  state.setAttribute("role", "status");
  const dot = document.createElement("span");
  dot.className = "dot";
  const stateText = document.createElement("span");
  const spacer = document.createElement("span");
  spacer.className = "set-spacer";
  const recheck = document.createElement("button");
  recheck.type = "button";
  recheck.className = "btn sm ghost";
  recheck.textContent = "Check again";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "btn sm ghost";
  cancel.textContent = "Cancel sign-in";
  cancel.hidden = true;
  state.append(dot, stateText, spacer, recheck, cancel);
  pane.append(state);

  const message = document.createElement("p");
  message.className = "set-msg";
  pane.append(message);

  const actions = document.createElement("div");
  actions.className = "set-actions";
  const action = document.createElement("button");
  action.type = "button";
  action.className = "btn primary";
  action.textContent = "Checking";
  action.disabled = true;
  const install = document.createElement("a");
  install.className = "btn";
  install.target = "_blank";
  install.rel = "noopener noreferrer";
  install.hidden = true;
  actions.append(action, install);
  pane.append(actions);

  // Codex device sign-in: an official page and a one-time code, never a form
  // that asks for the code here.
  const devicePanel = document.createElement("div");
  devicePanel.className = "set-msg set-device";
  devicePanel.dataset.tone = "ok";
  devicePanel.hidden = true;
  const verify = document.createElement("a");
  verify.target = "_blank";
  verify.rel = "noopener noreferrer";
  verify.textContent = "Copy code and open ChatGPT";
  verify.className = "btn primary";
  const deviceCode = document.createElement("p");
  devicePanel.append(verify, deviceCode);
  appendTextChild(devicePanel, "p", "Enter this code on the ChatGPT page. BotHearth connects automatically when you finish.");
  appendTextChild(devicePanel, "p", "If ChatGPT asks, enable device code login in Settings → Security.", "set-fine");
  pane.append(devicePanel);

  // Official CLI output stays plain text and exists only during this operator’s sign-in.
  const terminalPanel = document.createElement("form");
  terminalPanel.className = "set-terminal";
  terminalPanel.hidden = true;
  const terminalTitle = appendTextChild(terminalPanel, "p", "Official sign-in", "set-n");
  const terminalOutput = appendTextChild(terminalPanel, "pre", "");
  terminalOutput.tabIndex = 0;
  terminalOutput.setAttribute("aria-label", "Official sign-in output");
  const terminalLabel = appendTextChild(terminalPanel, "label", "Reply to sign-in", "set-field");
  const terminalReply = document.createElement("input");
  terminalReply.type = "text";
  terminalReply.autocomplete = "off";
  terminalReply.spellcheck = false;
  terminalReply.maxLength = 8192;
  terminalReply.placeholder = "Reply, or leave empty to press Enter";
  terminalLabel.append(terminalReply);
  const terminalSend = document.createElement("button");
  terminalSend.textContent = "Send to sign-in";
  terminalSend.className = "btn";
  terminalSend.type = "submit";
  terminalSend.disabled = true;
  terminalPanel.append(terminalSend);
  appendTextChild(terminalPanel, "p", "Sent to the provider’s sign-in process, separate from task chat.", "set-fine");
  pane.append(terminalPanel);

  const details = document.createElement("details");
  details.className = "set-details";
  appendTextChild(details, "summary", "Details");
  const list = document.createElement("dl");
  details.append(list);
  const modelField = document.createElement("label");
  modelField.className = "set-field";
  modelField.textContent = "Model";
  const model = document.createElement("input");
  model.maxLength = 512;
  model.setAttribute("autocomplete", "off");
  model.setAttribute("spellcheck", "false");
  modelField.append(model);
  const authField = document.createElement("label");
  authField.className = "set-field";
  authField.textContent = "Sign in with";
  const auth = document.createElement("select");
  for (const [value, title] of [
    ["subscription", "My Claude subscription"],
    ["console", "My Anthropic Console account"],
  ]) {
    const option = document.createElement("option");
    option.value = value as string;
    option.textContent = title as string;
    auth.append(option);
  }
  authField.append(auth);
  authField.hidden = true;
  details.append(modelField, authField);
  pane.append(details);

  appendTextChild(
    pane,
    "p",
    "Your chosen provider receives task context. Its eligibility rules, usage limits and charges apply.",
    "set-fine",
  );

  /* ---------------------------------------------------------------------- */

  let selected: Provider = "claude";
  let providerEdited = false;
  let connection: Connection | null = null;
  const others = new Map<Provider, Connection | null>();
  let runtimeAi: RuntimeAi | null = null;
  let checkedAt = Date.now();
  let busy = false;
  let connectAfterSignIn = false;
  let modelEdited = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let clock: ReturnType<typeof setInterval> | undefined;
  let revision = 0;
  let terminalRevision = 0;
  let terminalBusy = false;

  /**
   * The titlebar chip names the AI on every screen, and this pane is the only
   * place that changes which AI that is. The daemon emits no event for it, so
   * the chip is republished from here or it stays wrong until a reload.
   */
  const publishConnection = (result: Connection): void => {
    publishStatusPill({
      status: {
        task_start_available: true,
        ai: { provider: result.provider, limit: result.limit ?? null },
      },
      model: result.model || null,
      executionMode: result.provider,
    });
  };

  const clearDevice = () => {
    devicePanel.hidden = true;
    deviceCode.textContent = "";
    verify.removeAttribute("href");
  };

  const clearTerminal = () => {
    terminalRevision += 1;
    terminalBusy = false;
    terminalPanel.hidden = true;
    terminalOutput.textContent = "";
    terminalReply.value = "";
    terminalReply.disabled = true;
    terminalSend.disabled = true;
    if (connection) delete connection.native_terminal;
    for (const cached of others.values()) if (cached) delete cached.native_terminal;
  };

  const showTerminal = (result: Connection) => {
    if (result.status !== "signing_in" || result.execution_location !== "computer" ||
        result.native_terminal?.can_reply !== true || typeof result.native_terminal.output !== "string") {
      clearTerminal();
      return;
    }
    terminalTitle.textContent = `Official ${PROVIDER_NAME[result.provider]} sign-in`;
    terminalOutput.textContent = result.native_terminal.output.slice(-32_768);
    terminalPanel.hidden = false;
    terminalReply.disabled = terminalBusy;
    terminalSend.disabled = terminalBusy;
  };

  const paintDetails = () => {
    list.replaceChildren();
    const add = (term: string, value: string) => {
      appendTextChild(list, "dt", term);
      appendTextChild(list, "dd", value);
    };
    add("Chosen", PROVIDER_NAME[selected]);
    add("State", statusWord(connection?.status ?? null, connection?.limit));
    if (connection?.model) add("Model", connection.model);
    if (connection?.execution_location === "computer") {
      add("Runs in", "The bot’s computer");
    } else if (runtimeAi && runtimeAi.provider === selected) {
      add(
        "Where it was found",
        runtimeAi.cli_found
          ? runtimeAi.cli_path_kind === "path"
            ? "On your command-line PATH"
            : "In its usual place on the host"
          : "Not found on the host",
      );
      if (runtimeAi.detail) add("Last check said", runtimeAi.detail);
    }
    model.placeholder = "Exact model ID";
    authField.hidden =
      selected !== "claude" ||
      connection?.login_mode === "terminal" ||
      !["signed_out", "signing_in"].includes(connection?.status ?? "");
  };

  const paintRows = () => {
    for (const provider of order) {
      const row = rows.get(provider);
      if (!row) continue;
      const value = provider === selected ? connection : (others.get(provider) ?? null);
      const detected =
        runtimeAi?.cli_found === true && (runtimeAi.provider ?? selected) === provider;
      row.sub.textContent = providerRowCopy(provider, value, detected);
      row.button.setAttribute("aria-checked", String(provider === selected));
      row.button.tabIndex = provider === selected ? 0 : -1;
    }
  };

  const paintState = () => {
    const status = connection?.status ?? null;
    const limit = connection?.limit ?? null;
    const tone = statusTone(status, limit);
    dot.className = tone === "neutral" ? "dot" : `dot ${tone}`;
    const suffix =
      status === "connected" || status === "signed_out" || status === "missing"
        ? ` · last checked ${lastCheckedLabel(Date.now() - checkedAt)}`
        : "";
    stateText.textContent = `${statusWord(status, limit)}${suffix}`;
    cancel.hidden = status !== "signing_in";
  };

  const paintAction = () => {
    const status = connection?.status ?? null;
    const name = PROVIDER_NAME[selected];
    const dirty = connection?.status === "connected" && model.value.trim() !== connection.model;
    action.hidden = false;
    action.disabled = busy || status === "signing_in";
    switch (status) {
      case "connected":
        // A button that only restates the state is a dead control, so it is not
        // rendered at all.
        action.hidden = !dirty;
        action.textContent = "Save changes";
        break;
      case "signed_in":
        action.textContent = selected === "claude" ? "Connect Claude Code" : "Use my Codex login";
        break;
      case "signed_out":
        action.textContent =
          connection?.login_mode === "terminal" && connection.execution_location !== "computer"
            ? "Check again"
            : selected === "claude"
              ? "Sign in through Claude Code"
              : "Sign in with ChatGPT";
        break;
      case "signing_in":
        action.textContent = "Waiting for sign-in";
        break;
      case "missing":
        action.textContent = "Check again";
        break;
      case "error":
        action.textContent = "Try again";
        break;
      default:
        action.textContent = "Checking";
        action.disabled = true;
    }
    const url = https(connection?.install_url);
    install.hidden = status !== "missing" || !url;
    if (url) install.href = url;
    install.textContent = `Install ${name}${connection?.execution_location === "computer" ? " in the bot’s computer" : ""}`;
  };

  const paint = () => {
    paintRows();
    paintState();
    paintAction();
    paintDetails();
  };

  const failed = (error: unknown) => {
    if (!live()) return;
    clearDevice();
    clearTerminal();
    busy = false;
    connectAfterSignIn = false;
    connection = { ...connection, status: "error", provider: selected, model: model.value };
    message.dataset.tone = "danger";
    message.textContent =
      error instanceof Error
        ? error.message
        : "The connection could not be checked. Choose Check again in a moment.";
    paint();
  };

  const showDevice = (result: Connection) => {
    const challenge = result.device_auth;
    if (
      result.status === "signing_in" &&
      challenge?.verification_uri === DEVICE_VERIFICATION_URL &&
      DEVICE_CODE.test(challenge.user_code) &&
      Date.parse(challenge.expires_at) > Date.now()
    ) {
      verify.href = challenge.verification_uri;
      deviceCode.textContent = `One-time code: ${challenge.user_code}`;
      devicePanel.hidden = false;
      return;
    }
    clearDevice();
  };

  verify.addEventListener("click", (event) => {
    const challenge = connection?.device_auth;
    if (!live() || connection?.status !== "signing_in" || challenge?.verification_uri !== DEVICE_VERIFICATION_URL
      || !DEVICE_CODE.test(challenge.user_code) || !(Date.parse(challenge.expires_at) > Date.now())) {
      event.preventDefault();
      clearDevice();
      return;
    }
    const copyFailed = () => {
      if (live()) message.textContent = "Select and copy the code shown here, then enter it on the ChatGPT page.";
    };
    try { void navigator.clipboard.writeText(challenge.user_code).catch(copyFailed); }
    catch { copyFailed(); }
    // Keep the ordinary link navigation in this click so popup blockers do not
    // swallow the official sign-in page while the clipboard promise settles.
  });

  const refresh = async (): Promise<void> => {
    if (!live()) {
      clearDevice();
      clearTerminal();
      return;
    }
    clearTimeout(timer);
    const mine = ++revision;
    const params = new URLSearchParams();
    if (providerEdited || connection?.status === "signing_in") params.set("provider", selected);
    if (connection?.computer_id) params.set("computer_id", connection.computer_id);
    const query = params.toString();
    let result: Connection;
    try {
      result = (await apiGet(`/api/v1/connection${query ? `?${query}` : ""}`)) as Connection;
    } catch (error) {
      if (!live() || mine !== revision) return;
      throw error;
    }
    if (!live() || mine !== revision) return;
    checkedAt = Date.now();
    if (!providerEdited && (result.provider === "claude" || result.provider === "codex")) {
      selected = result.provider;
    }
    connection = result;
    showDevice(result);
    showTerminal(result);
    if (!modelEdited && typeof result.model === "string") model.value = result.model;

    switch (result.status) {
      case "connected":
        message.textContent = "";
        connectAfterSignIn = false;
        // Only the unqualified probe speaks for the AI the daemon is actually
        // using, so only that one may rewrite the chip every screen carries.
        if (!providerEdited) publishConnection(result);
        break;
      case "signed_in":
        message.textContent = "";
        if (connectAfterSignIn) {
          paint();
          await connect();
          return;
        }
        break;
      case "signed_out":
        message.dataset.tone = "warn";
        message.textContent =
          result.message ||
          (result.login_mode === "terminal"
            ? result.execution_location === "computer"
              ? `Start the official ${PROVIDER_NAME[selected]} sign-in in the bot’s computer.`
              : `Sign in to ${PROVIDER_NAME[selected]} on the BotHearth host, then check again.`
            : `Sign in through ${PROVIDER_NAME[selected]}’s own browser page. BotHearth never sees your password.`);
        break;
      case "signing_in":
        message.dataset.tone = "ok";
        message.textContent =
          result.login_mode === "device"
            ? result.message || "Finish the official Codex sign-in, then come back here."
            : result.login_mode === "terminal"
              ? result.message || (result.native_terminal
                ? "Follow the official sign-in steps below."
                : `Finish signing in to ${PROVIDER_NAME[selected]} on the BotHearth host, then check again.`)
            : "Finish signing in in your browser, then come back here. BotHearth connects on its own.";
        timer = setTimeout(() => {
          void refresh().catch(failed);
        }, POLL_MS);
        break;
      case "missing":
        message.dataset.tone = "warn";
        message.textContent = result.message || `Install ${PROVIDER_NAME[selected]}${result.execution_location === "computer" ? " in the bot’s computer" : " on the BotHearth host"}, then check again.`;
        break;
      case "error":
        message.dataset.tone = "danger";
        message.textContent = result.message ?? "The connection could not be checked. Choose Check again in a moment.";
        break;
    }
    paint();
  };

  const connect = async (): Promise<void> => {
    connectAfterSignIn = false;
    busy = true;
    paintAction();
    message.dataset.tone = "ok";
    message.textContent = "Connecting your account";
    const result = (await apiPost("/api/v1/connection/connect", {
      model: model.value.trim(),
      provider: selected,
      auth: auth.value,
      ...(connection?.computer_id ? { computer_id: connection.computer_id } : {}),
    })) as Connection;
    if (!live()) return;
    busy = false;
    if (result.status === "error") {
      throw new Error(result.message ?? "The account could not be connected. Check that you finished signing in, then try again.");
    }
    modelEdited = false;
    if (result.status === "connected") {
      connection = result;
      checkedAt = Date.now();
      publishConnection(result);
      message.dataset.tone = "ok";
      message.textContent = "";
      clearDevice();
      clearTerminal();
      paint();
      return;
    }
    await refresh();
  };

  const chooseProvider = (provider: Provider) => {
    if (provider === selected || busy) return;
    providerEdited = true;
    modelEdited = false;
    connectAfterSignIn = false;
    others.set(selected, connection);
    selected = provider;
    connection = others.get(provider) ?? null;
    model.value = "";
    message.textContent = "";
    clearDevice();
    clearTerminal();
    paint();
    void refresh().catch(failed);
  };

  for (const provider of order) {
    const row = rows.get(provider);
    row?.button.addEventListener("click", () => chooseProvider(provider));
    row?.button.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "ArrowLeft" && key !== "ArrowRight") return;
      event.preventDefault();
      const next = order[(order.indexOf(provider) + 1) % order.length] as Provider;
      chooseProvider(next);
      rows.get(next)?.button.focus();
    });
  }

  action.addEventListener("click", () => {
    if (busy || action.disabled) return;
    const status = connection?.status ?? null;
    busy = true;
    paintAction();
    void (async () => {
      if (status === "signed_in" || status === "connected") {
        await connect();
        busy = false;
        paintAction();
        return;
      }
      if (status === "signed_out" && (connection?.login_mode !== "terminal" || connection.execution_location === "computer")) {
        connectAfterSignIn = true;
        const result = (await apiPost("/api/v1/connection/sign-in", {
          model: model.value.trim(),
          provider: selected,
          auth: auth.value,
          ...(connection?.computer_id ? { computer_id: connection.computer_id } : {}),
        })) as Connection;
        if (result.status === "error") {
          throw new Error(result.message ?? "Sign-in could not start. Check that BotHearth is running, then try again.");
        }
      }
      busy = false;
      await refresh();
    })().catch(failed);
  });

  recheck.addEventListener("click", () => {
    if (recheck.disabled) return;
    recheck.disabled = true;
    message.textContent = "";
    void refresh()
      .catch(failed)
      .finally(() => {
        if (live()) recheck.disabled = false;
      });
  });

  cancel.addEventListener("click", () => {
    if (cancel.disabled) return;
    cancel.disabled = true;
    revision += 1;
    clearTimeout(timer);
    clearDevice();
    clearTerminal();
    connectAfterSignIn = false;
    void apiPost("/api/v1/connection/cancel", { provider: selected,
      ...(connection?.computer_id ? { computer_id: connection.computer_id } : {}),
    })
      .then(() => {
        busy = false;
        return refresh();
      })
      .catch(failed)
      .finally(() => {
        if (live()) cancel.disabled = false;
      });
  });

  terminalPanel.addEventListener("submit", (event) => {
    event.preventDefault();
    if (terminalBusy || terminalPanel.hidden || !connection?.native_terminal?.can_reply) return;
    const text = terminalReply.value;
    if (text.length > 8192 || /[\r\n\0]/.test(text)) {
      message.dataset.tone = "warn";
      message.textContent = "Send one line of up to 8,192 characters to sign-in.";
      return;
    }
    const mine = terminalRevision;
    terminalBusy = true;
    terminalReply.value = "";
    terminalReply.disabled = true;
    terminalSend.disabled = true;
    void apiPost("/api/v1/connection/input", { provider: selected, text,
      ...(connection.computer_id ? { computer_id: connection.computer_id } : {}),
    }).then(async () => {
      if (!live() || mine !== terminalRevision) return;
      terminalBusy = false;
      await refresh();
    }).catch((error) => {
      if (live() && mine === terminalRevision) failed(error);
    });
  });

  model.addEventListener("input", () => {
    modelEdited = true;
    paintAction();
  });

  paint();

  // The other provider’s row must be honest too, so both are probed once.
  void (async () => {
    try {
      const snapshot = (await apiGet("/api/v1/runtime")) as { ai?: RuntimeAi };
      if (!live()) return;
      runtimeAi = snapshot.ai ?? null;
      paint();
    } catch {
      // Detection is a nicety; the connection endpoint is the source of truth.
    }
  })();

  void refresh()
    .catch(failed)
    .then(async () => {
      if (!live()) return;
      const other = order.find((p) => p !== selected);
      if (!other || others.has(other)) return;
      try {
        const result = (await apiGet(`/api/v1/connection?provider=${other}`)) as Connection;
        if (!live()) return;
        delete result.native_terminal;
        others.set(other, result);
      } catch {
        others.set(other, null);
      }
      if (live()) paintRows();
    })
    .catch(() => {});

  clock = setInterval(() => {
    if (!live()) return;
    paintState();
  }, 30_000);

  return () => {
    disposed = true;
    clearTimeout(timer);
    if (clock !== undefined) clearInterval(clock);
    clearDevice();
    clearTerminal();
  };
}
