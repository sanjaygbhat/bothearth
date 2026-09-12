/**
 * The Settings sheet.
 *
 * Everything that is not a task lives here, in one sheet over whatever you were
 * looking at. `⌘,` opens it from anywhere — in the native shell the menu item
 * dispatches `modelbot:native` with `{kind:"open-settings"}`, and in a plain
 * browser the same shortcut is handled here.
 *
 * `#/settings` and `#/settings/:section` resolve to one registration, so moving
 * between sections swaps the pane without rebuilding the sheet or losing focus.
 * It is registered as a shell *overlay*, so the screen it was opened from stays
 * mounted behind the scrim instead of being replaced by an empty frame.
 */

import { apiDelete, apiGet, apiPost, humanApiError } from "./api.ts";
import { renderAiConnection } from "./connection.ts";
import { renderDevices } from "./devices.ts";
import { renderLicence } from "./licence.ts";
import { appendTextChild } from "./safe.ts";
import { refreshSession } from "./session.ts";
import {
  navigate,
  registerOverlay,
  theme,
  type RouteParams,
  type ShellView,
  type ThemeChoice,
} from "./shell.ts";
import { renderUsage } from "./usage.ts";

const REPO = "https://github.com/sanjaygbhat/bothearth";
const NICKNAME_KEY = "modelbot.computer-names";

type Section = {
  id: string;
  label: string;
  render(pane: HTMLElement): () => void;
};

type Computer = {
  id: string;
  name: string;
  capabilities: string[];
  persistent: boolean;
  status: string;
  state?: string;
  created_at: string;
};

type Task = { id: string; computer_id: string; goal: string; status: string };

/** A name you gave it. The daemon has no rename, so this stays on this Mac. */
function readNicknames(): Record<string, string> {
  try {
    const raw = localStorage.getItem(NICKNAME_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeNickname(id: string, name: string): void {
  try {
    const all = readNicknames();
    if (name) all[id] = name;
    else delete all[id];
    localStorage.setItem(NICKNAME_KEY, JSON.stringify(all));
  } catch {
    // Storage off: the name applies to this window and is not remembered.
  }
}

/** Plain words for what its computer is doing right now. */
function computerStateCopy(computer: Computer, busyWith: Task | undefined): string {
  if (busyWith) return "Working on a task right now";
  switch (computer.status) {
    case "running":
      return "Ready and waiting";
    case "paused":
      return "Asleep — it wakes up when a task starts";
    case "creating":
      return "Being set up";
    default:
      return "Off until the next task";
  }
}

const BUSY_MESSAGE =
  "A task is already using this browser. Let it finish or stop it before starting another.";
const HOLD_MESSAGE =
  "This computer is under Take control. Return control before forgetting its logins.";
const FORGET_BUSY_MESSAGE =
  "This computer has a task in progress. Stop or finish it before forgetting its logins.";
const FORGET_CONFIRM =
  "This forgets saved logins on this computer. The bot will need to sign in again on those sites.";

function renderComputers(pane: HTMLElement): () => void {
  let disposed = false;
  const live = () => !disposed && pane.isConnected;

  appendTextChild(pane, "h3", "Computers");
  appendTextChild(
    pane,
    "p",
    "Each computer has a separate browser profile and shares its workspace with BotHearth’s host.",
    "set-lede",
  );
  appendTextChild(
    pane,
    "p",
    "Each computer has its own Chromium. Signing in there does not sign in Arc or Chrome, and your everyday browser stays private from the model.",
    "set-lede",
  );

  const message = document.createElement("p");
  message.className = "set-msg";
  pane.append(message);

  const list = document.createElement("div");
  list.className = "set-rows";
  pane.append(list);

  const note = document.createElement("p");
  note.className = "set-fine";
  note.textContent =
    "The name is kept on this Mac, so you can tell one computer from another here. Erasing one throws away every site it was signed into.";
  pane.append(note);

  const fail = (error: unknown) => {
    if (!live()) return;
    message.dataset.tone = "danger";
    message.textContent = humanApiError(
      error,
      "Your computers could not be read just now. Check that BotHearth is running, then try again.",
    );
  };

  const refresh = async (): Promise<void> => {
    const [inventory, history] = await Promise.all([
      apiGet("/api/v1/computers") as Promise<{
        default_computer_id?: string | null;
        computers?: Computer[];
      }>,
      apiGet("/api/v1/tasks") as Promise<{ tasks?: Task[] }>,
    ]);
    if (!live()) return;
    const computers = inventory.computers ?? [];
    const tasks = history.tasks ?? [];
    const signedById = new Map<string, string[]>();
    await Promise.all(
      computers.map(async (computer) => {
        try {
          const signed = (await apiGet(
            `/api/v1/computers/${encodeURIComponent(computer.id)}/signed-in`,
          )) as { domains?: unknown };
          signedById.set(
            computer.id,
            Array.isArray(signed.domains)
              ? signed.domains.filter((domain): domain is string => typeof domain === "string")
              : [],
          );
        } catch {
          signedById.set(computer.id, []);
        }
      }),
    );
    if (!live()) return;
    const nicknames = readNicknames();
    const defaultId = inventory.default_computer_id ?? null;
    list.replaceChildren();

    if (computers.length === 0) {
      appendTextChild(
        list,
        "p",
        "Your bot does not have a computer yet. It gets one the moment you start your first task.",
        "set-note",
      );
      note.hidden = true;
      return;
    }
    note.hidden = false;

    const ordered = [...computers].sort((a, b) =>
      a.id === defaultId ? -1 : b.id === defaultId ? 1 : 0,
    );

    for (const computer of ordered) {
      const busyWith = tasks.find(
        (task) => task.computer_id === computer.id && ["running", "paused"].includes(task.status),
      );
      const isDefault = computer.id === defaultId;

      const row = document.createElement("div");
      row.className = "set-row";
      const text = document.createElement("div");
      text.className = "set-grow";

      const field = document.createElement("label");
      field.className = "set-field";
      field.textContent = isDefault ? "Your bot’s computer" : "Another computer";
      const name = document.createElement("input");
      name.value = nicknames[computer.id] ?? computer.name;
      name.setAttribute("autocomplete", "off");
      field.append(name);
      text.append(field);

      appendTextChild(
        text,
        "span",
        [
          computerStateCopy(computer, busyWith),
          computer.persistent
            ? "keeps the sites it signed into"
            : "keeps browser data and saved files on the host between tasks",
        ].join(" · "),
        "set-w",
      );
      const domains = signedById.get(computer.id) ?? [];
      appendTextChild(
        text,
        "span",
        domains.length > 0 ? `Signed-in sites: ${domains.join(", ")}` : "Signed-in sites: None",
        "set-w",
      );

      const controls = document.createElement("div");
      controls.className = "set-actions";

      const save = document.createElement("button");
      save.type = "button";
      save.className = "btn sm";
      save.textContent = "Save name";
      save.hidden = true;
      save.addEventListener("click", () => {
        writeNickname(computer.id, name.value.trim());
        save.hidden = true;
        message.dataset.tone = "ok";
        message.textContent = `Saved. This one is called “${name.value.trim() || computer.name}” on this Mac.`;
      });
      name.addEventListener("input", () => {
        save.hidden = name.value.trim() === (nicknames[computer.id] ?? computer.name);
      });
      controls.append(save);

      if (!isDefault) {
        const makeDefault = document.createElement("button");
        makeDefault.type = "button";
        makeDefault.className = "btn sm";
        makeDefault.textContent = "Use this one";
        makeDefault.disabled = !computer.capabilities.includes("browser");
        makeDefault.addEventListener("click", () => {
          makeDefault.disabled = true;
          void apiPost(`/api/v1/computers/${encodeURIComponent(computer.id)}/default`)
            .then(() => refresh())
            .catch((error) => {
              makeDefault.disabled = false;
              fail(error);
            });
        });
        controls.append(makeDefault);
      }

      if (computer.capabilities.includes("browser")) {
        const forget = document.createElement("button");
        forget.type = "button";
        forget.className = "btn sm danger";
        forget.textContent = "Forget this computer's logins";
        let forgetArmed = false;
        forget.addEventListener("click", () => {
          if (forget.disabled) return;
          if (busyWith) {
            message.dataset.tone = "warn";
            message.textContent = FORGET_BUSY_MESSAGE;
            return;
          }
          if (computer.state === "human-hold") {
            message.dataset.tone = "warn";
            message.textContent = HOLD_MESSAGE;
            return;
          }
          if (!forgetArmed) {
            forgetArmed = true;
            forget.textContent = "Yes, forget logins";
            message.dataset.tone = "warn";
            message.textContent = FORGET_CONFIRM;
            return;
          }
          forget.disabled = true;
          void apiPost(`/api/v1/computers/${encodeURIComponent(computer.id)}/forget-logins`)
            .then(async () => {
              if (!live()) return;
              message.dataset.tone = "ok";
              message.textContent =
                "Saved logins on this computer are gone. The bot will need to sign in again on those sites.";
              await refresh();
            })
            .catch((error) => {
              forget.disabled = false;
              fail(error);
            });
        });
        controls.append(forget);
      }

      const fresh = document.createElement("button");
      fresh.type = "button";
      fresh.className = "btn sm danger";
      fresh.textContent = "Use a fresh one";
      let armed = false;
      fresh.addEventListener("click", () => {
        if (fresh.disabled) return;
        if (busyWith) {
          message.dataset.tone = "warn";
          message.textContent = BUSY_MESSAGE;
          return;
        }
        if (!armed) {
          armed = true;
          fresh.textContent = "Yes, erase it";
          message.dataset.tone = "warn";
          message.textContent =
            "This throws the computer away and builds a clean one with your next task. Every site it was signed into will need signing in again.";
          return;
        }
        fresh.disabled = true;
        void apiDelete(`/api/v1/computers/${encodeURIComponent(computer.id)}`)
          .then(async () => {
            writeNickname(computer.id, "");
            if (!live()) return;
            message.dataset.tone = "ok";
            message.textContent =
              "Gone. Your bot builds itself a clean computer the next time you start a task.";
            await refresh();
          })
          .catch((error) => {
            fresh.disabled = false;
            fail(error);
          });
      });
      controls.append(fresh);

      row.append(text, controls);
      list.append(row);
    }
  };

  void refresh().catch(fail);
  return () => {
    disposed = true;
  };
}

const ASK_BEFORE_LABEL = "Ask before sensitive actions";
const ASK_BEFORE_WHY =
  "Ask before detected sends, uploads, deletes, checkout steps and new-site form submits made through BotHearth’s browser tools. The bot pauses only when it asks, or when you enable Ask before sensitive actions.";
const KILL_SWITCH_LABEL = "Stop the bot from taking any action (kill switch)";
const KILL_SWITCH_WHY =
  "When this is on, every tool call is refused until you turn it off.";

const OPTIONAL_GATES = [
  "external_send",
  "payment",
  "upload",
  "delete",
  "secret_entry",
  "new_domain",
] as const;
type SettingsGate = (typeof OPTIONAL_GATES)[number];

const GATE_LABELS: Record<SettingsGate, string> = {
  external_send: "Sending email or messages",
  payment: "Checkout steps (card entry always pauses for you)",
  upload: "Uploading files",
  delete: "Deleting files or data",
  secret_entry: "Entering passwords or secrets",
  new_domain: "Submitting forms on a new site",
};

function renderSensitive(pane: HTMLElement): () => void {
  let disposed = false;
  const live = () => !disposed && pane.isConnected;

  appendTextChild(pane, "h3", ASK_BEFORE_LABEL);
  const row = document.createElement("label");
  row.className = "set-toggle";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("aria-describedby", "set-ask-why");
  const text = document.createElement("span");
  text.className = "set-grow";
  appendTextChild(text, "span", ASK_BEFORE_LABEL, "set-n");
  const why = appendTextChild(text, "span", ASK_BEFORE_WHY, "set-w");
  why.id = "set-ask-why";
  row.append(input, text);
  pane.append(row);

  const gateInputs: HTMLInputElement[] = [];
  for (const gate of OPTIONAL_GATES) {
    const sub = document.createElement("label");
    sub.className = "set-toggle set-toggle-sub";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.gate = gate;
    const label = document.createElement("span");
    label.className = "set-grow";
    appendTextChild(label, "span", GATE_LABELS[gate], "set-n");
    sub.append(box, label);
    pane.append(sub);
    gateInputs.push(box);
  }

  appendTextChild(pane, "h3", KILL_SWITCH_LABEL);
  const killRow = document.createElement("label");
  killRow.className = "set-toggle";
  const killInput = document.createElement("input");
  killInput.type = "checkbox";
  killInput.dataset.killSwitch = "1";
  killInput.setAttribute("aria-describedby", "set-kill-why");
  const killText = document.createElement("span");
  killText.className = "set-grow";
  appendTextChild(killText, "span", KILL_SWITCH_LABEL, "set-n");
  const killWhy = appendTextChild(killText, "span", KILL_SWITCH_WHY, "set-w");
  killWhy.id = "set-kill-why";
  killRow.append(killInput, killText);
  pane.append(killRow);

  appendTextChild(pane, "h3", "Limits");
  appendTextChild(
    pane,
    "p",
    "These apply to API-adapter tasks you start after saving. Native Codex and Claude Code tasks run until the provider’s own plan limit.",
    "set-w",
  );

  const stepsField = document.createElement("label");
  stepsField.className = "set-field";
  stepsField.append("Maximum tool calls");
  const stepsInput = document.createElement("input");
  stepsInput.type = "number";
  stepsInput.min = "0";
  stepsInput.step = "1";
  stepsInput.dataset.limit = "max_steps";
  stepsField.append(stepsInput);
  appendTextChild(stepsField, "span", "0 = no limit", "set-w");
  pane.append(stepsField);

  const spendField = document.createElement("label");
  spendField.className = "set-field";
  spendField.append("Spend cap (USD)");
  const spendInput = document.createElement("input");
  spendInput.type = "number";
  spendInput.min = "0";
  spendInput.step = "0.01";
  spendInput.dataset.limit = "spend_cap_usd";
  spendField.append(spendInput);
  appendTextChild(spendField, "span", "0 = no limit", "set-w");
  pane.append(spendField);

  const message = document.createElement("p");
  message.className = "set-msg";
  pane.append(message);

  const setGateEnabled = (on: boolean) => {
    for (const box of gateInputs) box.disabled = !on;
  };

  const selectedGates = (): SettingsGate[] =>
    OPTIONAL_GATES.filter((_, index) => gateInputs[index]?.checked);

  const fail = (error: unknown, revert?: () => void) => {
    if (!live()) return;
    revert?.();
    message.dataset.tone = "danger";
    message.textContent = humanApiError(
      error,
      "This setting could not be saved just now. Check that BotHearth is running, then try again.",
    );
  };

  const saveGates = (on: boolean, previous: { master: boolean; gates: boolean[] }) => {
    message.textContent = "";
    delete message.dataset.tone;
    const gates = on ? selectedGates() : [];
    void apiPost(
      "/api/v1/session",
      on ? { ask_before_sensitive: true, policy_gates: gates } : { ask_before_sensitive: false },
    )
      .then((body) => {
        if (!live()) return;
        const armed = Boolean((body as { ask_before_sensitive?: unknown }).ask_before_sensitive);
        input.checked = armed;
        setGateEnabled(armed);
        message.dataset.tone = "ok";
        message.textContent = armed
          ? "On. BotHearth will ask before those actions."
          : "Off. Tasks will not stop for those actions.";
      })
      .catch((error) => {
        fail(error, () => {
          input.checked = previous.master;
          for (const [index, box] of gateInputs.entries())
            box.checked = previous.gates[index] === true;
          setGateEnabled(previous.master);
        });
      });
  };

  void apiGet("/api/v1/session")
    .then((body) => {
      if (!live()) return;
      const session = body as {
        ask_before_sensitive?: unknown;
        policy_gates?: unknown;
        kill_switch?: unknown;
        limits?: { max_steps?: unknown; spend_cap_usd?: unknown } | null;
      };
      const on = Boolean(session.ask_before_sensitive);
      input.checked = on;
      killInput.checked = session.kill_switch === true;
      const listed = Array.isArray(session.policy_gates)
        ? session.policy_gates.filter(
            (item): item is SettingsGate =>
              typeof item === "string" && (OPTIONAL_GATES as readonly string[]).includes(item),
          )
        : on
          ? [...OPTIONAL_GATES]
          : [];
      for (const [index, gate] of OPTIONAL_GATES.entries()) {
        const box = gateInputs[index];
        if (box) box.checked = listed.includes(gate);
      }
      setGateEnabled(on);
      const limits = session.limits;
      if (typeof limits?.max_steps === "number") stepsInput.value = String(limits.max_steps);
      else stepsInput.value = "0";
      if (typeof limits?.spend_cap_usd === "number")
        spendInput.value = String(limits.spend_cap_usd);
      else spendInput.value = "0";
    })
    .catch((error) => {
      if (!live()) return;
      message.dataset.tone = "danger";
      message.textContent = humanApiError(
        error,
        "This setting could not be read just now. Check that BotHearth is running, then try again.",
      );
    });

  killInput.addEventListener("change", () => {
    const on = killInput.checked;
    const previous = !on;
    message.textContent = "";
    delete message.dataset.tone;
    void apiPost("/api/v1/session", { kill_switch: on })
      .then((body) => {
        void refreshSession();
        if (!live()) return;
        const armed = (body as { kill_switch?: unknown }).kill_switch === true;
        killInput.checked = armed;
        message.dataset.tone = "ok";
        message.textContent = armed
          ? "On. The bot will refuse every action."
          : "Off. The bot can take actions again.";
      })
      .catch((error) => {
        fail(error, () => {
          killInput.checked = previous;
        });
      });
  });

  input.addEventListener("change", () => {
    const on = input.checked;
    const previous = { master: !on, gates: gateInputs.map((box) => box.checked) };
    if (on && selectedGates().length === 0) {
      for (const box of gateInputs) box.checked = true;
    }
    setGateEnabled(on);
    saveGates(on, previous);
  });

  for (const box of gateInputs) {
    box.addEventListener("change", () => {
      const previous = {
        master: input.checked,
        gates: gateInputs.map((item) => (item === box ? !item.checked : item.checked)),
      };
      saveGates(true, previous);
    });
  }

  const saveLimits = () => {
    const steps = Number(stepsInput.value);
    const spend = Number(spendInput.value);
    message.textContent = "";
    delete message.dataset.tone;
    if (!Number.isInteger(steps) || steps < 0) {
      message.dataset.tone = "danger";
      message.textContent = "Maximum tool calls must be 0 or a whole number.";
      return;
    }
    if (!Number.isFinite(spend) || spend < 0) {
      message.dataset.tone = "danger";
      message.textContent = "Spend cap must be 0 or a number.";
      return;
    }
    void apiPost("/api/v1/session", { max_steps: steps, spend_cap_usd: spend })
      .then(() => {
        if (!live()) return;
        message.dataset.tone = "ok";
        message.textContent = "Saved. New API-adapter tasks use these limits.";
      })
      .catch((error) => fail(error));
  };
  stepsInput.addEventListener("change", saveLimits);
  spendInput.addEventListener("change", saveLimits);

  return () => {
    disposed = true;
  };
}

function renderAbout(pane: HTMLElement): () => void {
  let disposed = false;
  const live = () => !disposed && pane.isConnected;

  appendTextChild(pane, "h3", "About");

  const lockup = document.createElement("div");
  lockup.className = "set-lockup";
  const mark = document.createElement("span");
  mark.className = "set-mark";
  mark.setAttribute("aria-hidden", "true");
  lockup.append(mark);
  appendTextChild(lockup, "span", "BotHearth", "set-wordmark");
  pane.append(lockup);

  const version = appendTextChild(pane, "p", "Checking version", "set-note");
  version.setAttribute("role", "status");

  // The additional business permission covers one free business bot and outputs.
  appendTextChild(pane, "p", "Source-available · one business bot free under the offer.", "set-tagline");
  appendTextChild(
    pane,
    "p",
    "BotHearth runs on this machine and connects to your installed model CLI. Remote providers receive model-visible task context and apply their own terms and data policies.",
    "set-lede set-about-note",
  );

  const links = document.createElement("div");
  links.className = "set-links";
  for (const [label, href] of [
    ["Read the documentation", `${REPO}#readme`],
    ["Report a problem", `${REPO}/issues/new`],
    ["View licence", `${REPO}/blob/main/LICENSE`],
    ["Licence and costs", `${REPO}/blob/main/COMMERCIAL.md`],
  ] as Array<[string, string]>) {
    const link = document.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    appendTextChild(link, "span", label);
    appendTextChild(link, "span", "↗", "set-go");
    links.append(link);
  }
  pane.append(links);

  void (async () => {
    try {
      const health = (await apiGet("/healthz")) as { version?: string };
      if (!live()) return;
      version.textContent = health.version
        ? `Version ${health.version} · running on this machine`
        : "Running on this machine";
    } catch {
      if (live()) version.textContent = "Running on this machine";
    }
  })();

  return () => {
    disposed = true;
  };
}

const SECTIONS: Section[] = [
  { id: "ai", label: "Model connection", render: renderAiConnection },
  { id: "computers", label: "Computers", render: renderComputers },
  { id: "sensitive", label: "Sensitive actions", render: renderSensitive },
  { id: "devices", label: "Devices", render: renderDevices },
  { id: "usage", label: "Usage", render: renderUsage },
  { id: "licence", label: "Licence", render: renderLicence },
  { id: "about", label: "About", render: renderAbout },
];

export function resolveSection(id: string | undefined): Section {
  return SECTIONS.find((section) => section.id === id) ?? (SECTIONS[0] as Section);
}

export function isSettingsHash(hash: string): boolean {
  const path = hash.replace(/^#/, "").split("?")[0] ?? "";
  return path === "/settings" || path.startsWith("/settings/");
}

/** Where Esc goes back to: the last screen that was not the sheet. */
let returnHash = "#/";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (node) => !node.hidden && node.offsetParent !== null,
  );
}

const THEMES: Array<[ThemeChoice, string]> = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

function buildAppearance(): HTMLElement {
  const foot = document.createElement("div");
  foot.className = "set-foot";
  appendTextChild(foot, "span", "Appearance", "set-foot-label");
  const group = document.createElement("div");
  group.className = "set-seg";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Appearance");
  const buttons = new Map<ThemeChoice, HTMLButtonElement>();
  const paint = () => {
    const current = theme.get();
    for (const [choice, button] of buttons) {
      button.setAttribute("aria-pressed", String(choice === current));
    }
  };
  for (const [choice, label] of THEMES) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      theme.set(choice);
      paint();
    });
    buttons.set(choice, button);
    group.append(button);
  }
  paint();
  foot.append(group);
  return foot;
}

type Sheet = {
  root: HTMLElement;
  pane: HTMLElement;
  rail: HTMLElement;
  show(id: string): void;
  destroy(): void;
};

function buildSheet(host: HTMLElement, close: () => void): Sheet {
  const scrim = document.createElement("div");
  scrim.className = "set-scrim";
  scrim.addEventListener("click", close);

  const root = document.createElement("section");
  root.className = "set-sheet";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "set-title");

  const head = document.createElement("header");
  head.className = "set-head";
  const title = appendTextChild(head, "h2", "Settings");
  title.id = "set-title";
  const spacer = document.createElement("span");
  spacer.className = "set-spacer";
  const done = document.createElement("button");
  done.type = "button";
  done.className = "btn sm ghost";
  appendTextChild(done, "span", "Done");
  appendTextChild(done, "kbd", "esc");
  done.setAttribute("aria-label", "Close settings");
  done.addEventListener("click", close);
  head.append(spacer, done);

  const cols = document.createElement("div");
  cols.className = "set-cols";
  const rail = document.createElement("nav");
  rail.className = "set-rail";
  rail.setAttribute("aria-label", "Settings sections");
  const pane = document.createElement("div");
  pane.className = "set-pane";
  pane.tabIndex = -1;
  cols.append(rail, pane);

  const buttons = new Map<string, HTMLButtonElement>();
  for (const section of SECTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = section.label;
    button.addEventListener("click", () => navigate(`#/settings/${section.id}`));
    buttons.set(section.id, button);
    rail.append(button);
  }

  root.append(head, cols, buildAppearance());
  host.append(scrim, root);

  let dispose: (() => void) | null = null;
  let current = "";

  const show = (id: string) => {
    const section = resolveSection(id);
    if (section.id === current) return;
    const previous = current;
    current = section.id;
    dispose?.();
    dispose = null;
    pane.replaceChildren();
    pane.scrollTop = 0;
    for (const [key, button] of buttons) {
      if (key === section.id) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    dispose = section.render(pane);

    // Focus follows the selection, but only when the rail already had it:
    // moving between sections from a link or the URL must not steal focus out
    // of the pane a person is reading. Without this the ring stays on whichever
    // row had it while `aria-current` moves underneath.
    if (!previous) return;
    const active = document.activeElement;
    if (!active || !rail.contains(active)) return;
    buttons.get(section.id)?.focus();
  };

  return {
    root,
    pane,
    rail,
    show,
    destroy() {
      dispose?.();
      dispose = null;
      scrim.remove();
      root.remove();
    },
  };
}

/** Esc closes, Tab cycles inside, and focus goes back where it came from. */
export function createSettingsView(): ShellView {
  let sheet: Sheet | null = null;
  let restore: HTMLElement | null = null;
  let keys: ((event: KeyboardEvent) => void) | null = null;

  const close = () => {
    navigate(isSettingsHash(returnHash) ? "#/" : returnHash);
  };

  return {
    mount(el, params: RouteParams) {
      restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      sheet = buildSheet(el, close);
      sheet.show(params.section ?? "");

      keys = (event: KeyboardEvent) => {
        if (!sheet) return;
        if (event.key === "Escape") {
          event.preventDefault();
          close();
          return;
        }
        if (event.key !== "Tab") return;
        const stops = focusable(sheet.root);
        if (stops.length === 0) return;
        const first = stops[0] as HTMLElement;
        const last = stops[stops.length - 1] as HTMLElement;
        const active = document.activeElement;
        if (!sheet.root.contains(active)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
          return;
        }
        if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
      };
      document.addEventListener("keydown", keys, true);

      // The section list is the one control a keyboard user wants under their
      // hands on entry. A pointer-opened sheet shows no ring, because
      // :focus-visible follows the input modality.
      const current = sheet.rail.querySelector<HTMLElement>('button[aria-current="page"]');
      (current ?? sheet.pane).focus();
    },
    update(params: RouteParams) {
      sheet?.show(params.section ?? "");
    },
    unmount() {
      if (keys) document.removeEventListener("keydown", keys, true);
      keys = null;
      sheet?.destroy();
      sheet = null;
      if (restore?.isConnected) restore.focus();
      restore = null;
    },
  };
}

let registered = false;

/** Register the sheet’s route and its two global openers. Idempotent. */
export function registerSettings(): void {
  if (registered) return;
  registered = true;

  registerOverlay("#/settings/:section?", createSettingsView());

  const openSettings = () => {
    if (!isSettingsHash(location.hash)) navigate("#/settings");
  };

  // In the native shell the menu item sends the event below; in a browser the
  // key itself is handled here.
  window.addEventListener("keydown", (event) => {
    if (event.key !== "," || !(event.metaKey || event.ctrlKey) || event.altKey) return;
    event.preventDefault();
    openSettings();
  });

  window.addEventListener("modelbot:native", (event) => {
    const detail = (event as CustomEvent<{ kind?: string }>).detail;
    if (detail?.kind === "open-settings") openSettings();
  });

  const remember = () => {
    if (!isSettingsHash(location.hash)) returnHash = location.hash || "#/";
  };
  window.addEventListener("hashchange", remember);
  remember();
}

registerSettings();
