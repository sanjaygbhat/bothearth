/**
 * The command palette and the keyboard map (ux-spec §2.7).
 *
 * This runner has no DOM, so what is tested here is the logic a rendering test
 * would only re-state: what the palette offers, how it ranks a query, which
 * commands a view has to claim before they work, and that the keyboard map and
 * the shortcuts are the same list. The rendered surface — 44 px rows, focus,
 * light and dark, phone width — is verified in a real browser.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

type AnyRecord = Record<string, unknown>;
const globals = globalThis as unknown as AnyRecord;

class FakeWindow extends EventTarget {
  opened: string[] = [];
  focus(): void {}
  open(url: string): null {
    this.opened.push(url);
    return null;
  }
}

const fakeWindow = new FakeWindow();
const fakeLocation = {
  href: "http://127.0.0.1:7804/",
  origin: "http://127.0.0.1:7804",
  protocol: "http:",
  host: "127.0.0.1:7804",
  search: "",
  hash: "#/",
};

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

globals["window"] = fakeWindow;
globals["location"] = fakeLocation;
globals["sessionStorage"] = new MemoryStorage();
globals["localStorage"] = new MemoryStorage();
globals["document"] = {
  title: "ModelBot",
  readyState: "complete",
  body: null,
  documentElement: {
    setAttribute: () => {},
    removeAttribute: () => {},
  },
  adoptedStyleSheets: [] as unknown[],
  querySelector: () => null,
  getElementById: () => null,
  addEventListener: () => {},
};

const {
  KEYBOARD_MAP,
  bindCommand,
  closeOverlay,
  fuzzy,
  isOverlayOpen,
  listCommands,
  runCommand,
} = await import("../../../src/ui/palette.ts");

const commands: string[] = [];
fakeWindow.addEventListener("modelbot:command", (event) => {
  commands.push((event as CustomEvent<{ command: string }>).detail.command);
});

beforeEach(() => {
  commands.length = 0;
  fakeWindow.opened.length = 0;
  fakeLocation.hash = "#/";
});

/* =========================================================================
 * What is on offer
 * ====================================================================== */

describe("the palette's commands", () => {
  it("offers every action ux-spec §2.7 says it must, and no jargon", () => {
    const listed = listCommands();
    const byId = new Map(listed.map((command) => [command.id, command]));

    for (const id of [
      "new-task",
      "settings",
      "switch-theme",
      "go-to-task",
      "stop-task",
      "take-control",
      "give-control-back",
      "docs",
    ]) {
      assert.ok(byId.has(id), `missing command: ${id}`);
    }

    const banned = /daemon|bootstrap|token|computer_id|epoch|csrf|workspace|container|sidecar|proxy/i;
    for (const command of listed) {
      assert.doesNotMatch(command.title, banned, command.title);
      assert.doesNotMatch(command.unavailableReason, banned, command.unavailableReason);
    }
  });

  it("keeps the resting list short — theme variants only surface on a search", () => {
    const resting = listCommands().filter((command) => !command.deep);
    const deep = listCommands().filter((command) => command.deep);
    assert.ok(resting.length <= 9, `resting list is ${resting.length} long`);
    assert.deepEqual(
      deep.map((command) => command.id).sort(),
      ["theme-dark", "theme-light", "theme-system"],
    );
  });

  it("carries the same shortcut on the command as the keyboard map does", () => {
    const map = new Map<string, string[]>();
    for (const group of KEYBOARD_MAP) {
      for (const row of group.rows) map.set(row.action, row.keys);
    }
    assert.deepEqual(map.get("Start a new task"), ["⌘", "N"]);
    assert.deepEqual(map.get("Find any command"), ["⌘", "K"]);
    assert.deepEqual(map.get("Open settings"), ["⌘", ","]);
    assert.deepEqual(map.get("Show this list"), ["⌘", "/"]);

    const byId = new Map(listCommands().map((command) => [command.id, command]));
    assert.deepEqual(byId.get("new-task")?.keys, ["⌘", "N"]);
    assert.deepEqual(byId.get("settings")?.keys, ["⌘", ","]);
    assert.deepEqual(byId.get("stop-task")?.keys, ["⌘", "."]);
    assert.deepEqual(byId.get("take-control")?.keys, ["⌘", "⇧", "T"]);
  });

  it("documents every key ux-spec §2.7 lists", () => {
    const all = KEYBOARD_MAP.flatMap((group) => group.rows.map((row) => row.keys.join("")));
    for (const combo of ["⌘N", "⌘⏎", "⏎", "esc", "⌘K", "⌘,", "⌘.", "⌘⇧T", "⌘[", "⌘]", "⌘L", "/"]) {
      assert.ok(all.includes(combo), `keyboard map is missing ${combo}`);
    }
  });
});

/* =========================================================================
 * Commands a view has to claim
 * ====================================================================== */

describe("commands the task view owns", () => {
  it("is unavailable with a plain reason until a view claims it", () => {
    const before = listCommands().find((command) => command.id === "stop-task");
    assert.equal(before?.available, false);
    assert.equal(before?.unavailableReason, "Open a task first.");

    let stopped = 0;
    const release = bindCommand("stop-task", { run: () => void (stopped += 1) });
    assert.equal(listCommands().find((command) => command.id === "stop-task")?.available, true);

    runCommand("stop-task");
    assert.equal(stopped, 1);
    assert.deepEqual(commands, ["stop-task"], "the window event fires alongside the handler");

    release();
    runCommand("stop-task");
    assert.equal(stopped, 1, "an unclaimed command does nothing rather than half-doing it");
  });

  it("respects a binding that reports itself unavailable right now", () => {
    let ran = 0;
    const release = bindCommand("take-control", {
      run: () => void (ran += 1),
      available: () => false,
    });
    assert.equal(listCommands().find((command) => command.id === "take-control")?.available, false);
    runCommand("take-control");
    assert.equal(ran, 0);
    release();
  });
});

/* =========================================================================
 * The always-available commands
 * ====================================================================== */

describe("running a command", () => {
  it("takes New task home and tells the view to clear the draft", () => {
    fakeLocation.hash = "#/tasks/t_1";
    runCommand("new-task");
    assert.equal(fakeLocation.hash, "#/");
    assert.deepEqual(commands, ["new-task"]);
  });

  it("opens settings on its own route", () => {
    runCommand("settings");
    assert.equal(fakeLocation.hash, "#/settings");
    assert.deepEqual(commands, ["settings"]);
  });

  it("cycles the theme and offers each choice directly", () => {
    runCommand("switch-theme");
    assert.deepEqual(commands, ["theme-light"]);
    runCommand("switch-theme");
    assert.deepEqual(commands, ["theme-light", "theme-dark"]);
    runCommand("switch-theme");
    assert.deepEqual(commands, ["theme-light", "theme-dark", "theme-system"]);
    runCommand("theme-dark");
    assert.equal(commands[3], "theme-dark");
  });

  it("sends the docs out to a browser, never into this window", () => {
    runCommand("docs");
    assert.equal(fakeWindow.opened.length, 1);
    assert.match(fakeWindow.opened[0] ?? "", /^https:\/\//);
    assert.equal(fakeLocation.hash, "#/", "the docs never take over the app's own route");
  });

  it("ignores a command that does not exist", () => {
    runCommand("delete-everything");
    assert.deepEqual(commands, []);
  });
});

/* =========================================================================
 * Filtering
 * ====================================================================== */

describe("fuzzy filter", () => {
  it("matches a subsequence and refuses anything else", () => {
    assert.ok(fuzzy("nt", "New task"));
    assert.ok(fuzzy("newtask", "New task"));
    assert.ok(fuzzy("", "New task"));
    assert.equal(fuzzy("xyz", "New task"), null);
    assert.equal(fuzzy("task new", "New task"), null, "order matters in a subsequence");
  });

  it("is case-insensitive and reports where it matched, for highlighting", () => {
    const match = fuzzy("NEW", "New task");
    assert.deepEqual(match?.positions, [0, 1, 2]);
    assert.equal(match?.contiguous, true);
  });

  it("marks only unbroken runs, so a match never sprays letters over a sentence", () => {
    assert.equal(fuzzy("cont", "Take control")?.contiguous, true);
    const scattered = fuzzy("cont", "Check every link on modelbot.dev and list the broken ones");
    assert.ok(scattered, "it still matches, and still ranks");
    assert.equal(scattered?.contiguous, false, "but it is not highlighted");
  });

  it("ranks the thing a person meant first", () => {
    const rank = (query: string, titles: string[]) =>
      titles
        .map((title) => ({ title, match: fuzzy(query, title) }))
        .filter((row) => row.match !== null)
        .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
        .map((row) => row.title);

    assert.equal(
      rank("new", ["Show the keyboard shortcuts", "New task", "Open the docs"])[0],
      "New task",
      "a prefix beats a buried match",
    );
    assert.equal(
      rank("stop", ["Show the keyboard shortcuts", "Stop this task"])[0],
      "Stop this task",
      "adjacent letters beat scattered ones",
    );
    assert.equal(
      rank("gcb", ["Go to task…", "Give control back"])[0],
      "Give control back",
      "word initials find the command",
    );
    assert.equal(
      rank("theme", ["Switch theme", "Use the light theme"])[0],
      "Switch theme",
      "the shorter label wins a tie",
    );
  });
});

/* =========================================================================
 * Overlay bookkeeping
 * ====================================================================== */

describe("overlays", () => {
  it("reports nothing open, and closing nothing is not an error", () => {
    assert.equal(isOverlayOpen(), null);
    assert.equal(closeOverlay(), false);
  });
});
