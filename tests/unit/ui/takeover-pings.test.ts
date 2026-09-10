/**
 * The browser half of "your bot needs you": the desktop-alerts permission ask.
 *
 * The alerts themselves (dedup across a reload, closing an answered request,
 * never putting task text on the desktop) are covered in native.test.ts, which
 * drives them through the attention loop that owns them.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

type AnyRecord = Record<string, unknown>;
const globals = globalThis as unknown as AnyRecord;

/* -------------------------------------------------------------------------
 * Just enough DOM to build one card.
 * ---------------------------------------------------------------------- */

class FakeElement {
  readonly tag: string;
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly handlers = new Map<string, (event?: unknown) => void>();
  parent: FakeElement | null = null;
  className = "";
  id = "";
  type = "";
  textContent = "";

  constructor(tag: string) {
    this.tag = tag;
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) {
      if (typeof node === "string") {
        this.textContent += node;
        continue;
      }
      node.parent = this;
      this.children.push(node);
    }
  }

  addEventListener(name: string, fn: (event?: unknown) => void): void {
    this.handlers.set(name, fn);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  remove(): void {
    const siblings = this.parent?.children;
    if (!siblings) return;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parent = null;
  }

  /** Depth-first text search, for finding a button by its label. */
  find(text: string): FakeElement | null {
    if (this.textContent === text) return this;
    for (const child of this.children) {
      const found = child.find(text);
      if (found) return found;
    }
    return null;
  }

  get text(): string {
    return [this.textContent, ...this.children.map((child) => child.text)].join(" ").trim();
  }
}

const body = new FakeElement("body");

class MemoryStorage {
  readonly map = new Map<string, string>();
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

const localStore = new MemoryStorage();
let permission = "default";
let requests = 0;

class FakeNotification {
  static get permission(): string {
    return permission;
  }
  static async requestPermission(): Promise<string> {
    requests += 1;
    return permission;
  }
  close(): void {}
}

class FakeWindow extends EventTarget {
  focus(): void {}
}

globals["window"] = new FakeWindow();
globals["location"] = { hash: "", protocol: "http:", host: "127.0.0.1:7804" };
globals["sessionStorage"] = new MemoryStorage();
globals["localStorage"] = localStore;
globals["Notification"] = FakeNotification;
globals["document"] = {
  title: "ModelBot",
  readyState: "complete",
  body,
  adoptedStyleSheets: [] as unknown[],
  createElement: (tag: string) => new FakeElement(tag),
  createTextNode: (text: string) => {
    const node = new FakeElement("#text");
    node.textContent = text;
    return node;
  },
  querySelector: () => null,
  getElementById: () => null,
  addEventListener: () => {},
};

const { DesktopAlerts, dismissAlertsPrompt, promptForAlerts } = await import(
  "../../../src/ui/takeover-pings.ts"
);

function card(): FakeElement | undefined {
  return body.children.find((child) => child.className === "mb-ask");
}

beforeEach(() => {
  dismissAlertsPrompt();
  body.children.length = 0;
  localStore.map.clear();
  permission = "default";
  requests = 0;
});

/* =========================================================================
 * The ask
 * ====================================================================== */

describe("the contextual alerts ask", () => {
  it("says why, in plain words, and offers a real way to decline", () => {
    assert.equal(promptForAlerts(), true);
    const shown = card();
    assert.ok(shown, "the card is on screen");
    assert.equal(shown?.attributes.get("role"), "status", "it announces, it does not trap focus");

    const text = shown?.text ?? "";
    assert.match(text, /Want a heads-up when your bot needs you\?/);
    assert.match(text, /Task details stay out of alerts/, "the privacy promise is stated up front");
    assert.ok(shown?.find("Turn on alerts"), "primary action");
    assert.ok(shown?.find("Not now"), "declining is a real button, not a dismissal X");
    assert.doesNotMatch(text, /Enable desktop alerts/, "the old footer-button copy is gone");
    assert.doesNotMatch(text, /permission|notification API|browser setting/i, "no jargon");
  });

  it("asks exactly once, whatever the person answers", () => {
    assert.equal(promptForAlerts(), true);
    assert.equal(promptForAlerts(), false, "it never doubles up while it is showing");
    card()?.find("Not now")?.handlers.get("click")?.();
    assert.equal(card(), undefined, "declining takes it away");

    assert.equal(promptForAlerts(), false, "and it never comes back");
    assert.equal(localStore.getItem("modelbot.alerts.asked"), "1");
    assert.equal(requests, 0, "declining never reaches the browser prompt");
  });

  it("never asks when the browser has already decided", () => {
    for (const decided of ["granted", "denied"]) {
      dismissAlertsPrompt();
      localStore.map.clear();
      permission = decided;
      assert.equal(promptForAlerts(), false, decided);
      assert.equal(DesktopAlerts.asked(), true, decided);
    }
  });

  it("never asks when the browser cannot notify at all", () => {
    const saved = globals["Notification"];
    delete globals["Notification"];
    try {
      assert.equal(promptForAlerts(), false);
      assert.equal(card(), undefined);
    } finally {
      globals["Notification"] = saved;
    }
  });

  it("takes the ask away once the person accepts", async () => {
    promptForAlerts();
    card()?.find("Turn on alerts")?.handlers.get("click")?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(requests, 1, "the browser prompt only ever follows a click");
    assert.equal(card(), undefined);
  });

  it("closes on Escape", () => {
    promptForAlerts();
    card()?.handlers.get("keydown")?.({ key: "Escape", stopPropagation: () => {} });
    assert.equal(card(), undefined);
  });
});
