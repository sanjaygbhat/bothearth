import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  DRIVING_HINT,
  LivePanel,
  phaseCopy,
  screenLabel,
  shortUrl,
  waitingCopy,
  type PanelPhase,
} from "../../../src/ui/live/panel.ts";
import { icon, checkMark } from "../../../src/ui/live/icons.ts";
import { installDom, settle } from "./fake-dom.ts";

describe("live view url", () => {
  it("shows a bare host and path, never a scheme or a query string", () => {
    assert.equal(shortUrl("https://google.com/flights?q=1#x"), "google.com/flights");
    assert.equal(shortUrl("https://google.com/"), "google.com");
    assert.equal(shortUrl("http://localhost:7802/a/b/"), "localhost:7802/a/b");
    assert.equal(shortUrl(null), null);
    assert.equal(shortUrl("not a url"), null);
  });

  it("refuses anything that is not http(s), so no scheme can be smuggled in", () => {
    for (const raw of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"]) {
      assert.equal(shortUrl(raw), null, raw);
    }
  });
});

describe("live view copy", () => {
  it("gives every phase a word, a dot and a caption — colour is never alone", () => {
    const phases: PanelPhase[] = [
      "connecting", "live", "paused", "driving", "observing", "ended", "offline",
    ];
    const words = new Set<string>();
    for (const phase of phases) {
      const copy = phaseCopy(phase);
      assert.ok(copy.state.length > 0, phase);
      assert.match(copy.dot, /^dot/, phase);
      assert.ok(copy.note.length > 10, phase);
      assert.doesNotMatch(`${copy.state} ${copy.note}`, /epoch|screencast|frame_ack|websocket/i);
      words.add(copy.state);
    }
    assert.equal(words.size, phases.length, "each phase reads differently");
    assert.equal(phaseCopy("paused").dim, true);
    assert.match(phaseCopy("driving").note, /Frozen for your bot/);
    assert.match(phaseCopy("paused").note, /Nothing happens on its computer until you answer/);
    assert.match(phaseCopy("observing").note, /Nothing you type here is sent/);
    // The frame is the one this page received; the daemon keeps no picture.
    assert.match(phaseCopy("ended").note, /in this session/);
  });

  it("names the surface for a screen reader by who is driving it", () => {
    assert.equal(screenLabel("driving", "google.com"), "Its screen — you’re driving");
    assert.equal(screenLabel("observing", "google.com"), "Its screen — someone else is driving");
    assert.equal(screenLabel("live", "google.com"), "What your bot sees: google.com");
  });

  it("says what it is waiting for rather than showing an empty rectangle", () => {
    // A browser with no page open still paints frames, so the wait has to be
    // described in words while there is nothing worth looking at.
    assert.match(waitingCopy("connecting"), /Starting its computer/);
    assert.match(waitingCopy("paused"), /Waiting for your answer/);
    assert.match(waitingCopy("offline"), /choose Reconnect/);
    for (const phase of ["connecting", "paused", "offline"] as PanelPhase[]) {
      assert.doesNotMatch(waitingCopy(phase), /frame|websocket|epoch/i);
    }
  });
});

describe("live view panel", () => {
  function panel() {
    // No computer id: the panel renders without opening a socket, which is
    // exactly the "no live view to show" case and keeps the test hermetic.
    return new LivePanel({ computerId: null });
  }

  it("never shows an ambiguous empty rectangle", () => {
    const dom = installDom();
    try {
      const p = panel();
      const waiting = p.root.querySelector(".waiting");
      assert.ok(waiting);
      assert.equal(waiting.hidden, false);
      assert.ok(waiting.textContent.length > 0);
      assert.ok(p.root.querySelector(".view .bar .url"), "the frame keeps its URL bar");
    } finally {
      dom.restore();
    }
  });

  it("keeps the waiting copy up until its browser has a page to show", () => {
    const dom = installDom();
    try {
      const p = new LivePanel({ computerId: "cmp_1" });
      const waiting = p.root.querySelector(".waiting")!;
      // A blank tab paints frames too, so a frame is not yet a picture.
      (p as unknown as { hasFrame: boolean }).hasFrame = true;
      p.setPhase("paused");
      assert.equal(waiting.hidden, false);
      assert.match(waiting.textContent, /Waiting for your answer/);
      p.setUrl("https://mail.google.com/");
      assert.equal(waiting.hidden, true, "the page itself is the picture now");
    } finally {
      dom.restore();
    }
  });

  it("marks the frame and the canvas when a person takes the keyboard", () => {
    const dom = installDom();
    try {
      const p = panel();
      const view = p.root.querySelector(".view");
      assert.ok(view);
      assert.equal(view.classList.contains("human"), false);
      assert.equal(p.canvas.tabIndex, -1, "not a tab stop while the bot drives (§7)");

      p.setPhase("driving");
      assert.equal(view.classList.contains("human"), true);
      assert.equal(p.canvas.tabIndex, 0);
      assert.equal(p.root.querySelector(".side-head .state")?.textContent, "You are driving");

      p.setPhase("live");
      assert.equal(view.classList.contains("human"), false);
      assert.equal(view.classList.contains("releasing"), true, "the handoff reverses");
      assert.equal(p.canvas.tabIndex, -1);
    } finally {
      dom.restore();
    }
  });

  it("names the page the canvas is showing, for anyone who cannot see it", () => {
    const dom = installDom();
    try {
      const p = panel();
      assert.equal(p.canvas.getAttribute("aria-label"), "What your bot sees");
      p.setUrl("https://google.com/flights?q=1");
      assert.equal(p.root.querySelector(".url")?.textContent, "google.com/flights");
      assert.equal(p.canvas.getAttribute("aria-label"), "What your bot sees: google.com/flights");
      assert.equal(p.getUrl(), "google.com/flights");
    } finally {
      dom.restore();
    }
  });

  it("hides its actions on a finished task rather than leaving them dead", () => {
    const dom = installDom();
    try {
      const p = panel();
      const buttons = p.root.querySelectorAll(".view-acts button");
      assert.equal(buttons.length, 3, "take, full screen, reconnect");
      p.setActionsVisible(false, false);
      assert.equal(buttons[0]?.hidden, true);
      assert.equal(buttons[1]?.hidden, true);
      p.setActionsVisible(true, true);
      assert.equal(buttons[0]?.hidden, false);
      p.setTakeLabel("Take control instead", false);
      assert.equal(buttons[0]?.textContent, "Take control instead");
    } finally {
      dom.restore();
    }
  });

  it("says one thing over the picture, and takes it away again by itself", async () => {
    const dom = installDom({ timers: "manual" });
    try {
      const p = new LivePanel({ computerId: null });
      const notice = p.root.querySelector(".screen .notice")!;
      assert.equal(notice.hidden, true, "the notice is on screen before anything happened");
      assert.equal(notice.getAttribute("aria-live"), "polite");

      p.setNotice("You have control.");
      assert.equal(notice.hidden, false);
      assert.equal(notice.textContent, "You have control.");
      assert.equal(notice.classList.contains("warn"), false);

      // It never waits for a click: six seconds and it is gone.
      dom.runTimers();
      assert.equal(notice.hidden, true);
      assert.equal(notice.textContent, "");

      p.setNotice("Your bot is still finishing a step.", "warn");
      assert.equal(notice.classList.contains("warn"), true);
      p.clearNotice();
      assert.equal(notice.hidden, true);
      assert.equal(dom.pendingTimers(), 0, "a dismissed notice left its timer running");
    } finally {
      dom.restore();
    }
  });

  it("toggles full screen through the caller, and says how to get out", async () => {
    const dom = installDom();
    try {
      const seen: boolean[] = [];
      const p = new LivePanel({ computerId: null, onFullScreen: (v) => seen.push(v) });
      const full = p.root.querySelectorAll(".view-acts button")[1]!;
      assert.equal(full.textContent, "Full screen");
      full.click();
      await settle();
      assert.deepEqual(seen, [true]);
      assert.equal(p.isFullScreen(), true);
      assert.equal(full.textContent, "Leave full screen");
      full.click();
      await settle();
      assert.deepEqual(seen, [true, false]);
    } finally {
      dom.restore();
    }
  });
});

describe("glyphs", () => {
  it("builds SVG node by node — no markup string ever reaches a parser", () => {
    const dom = installDom();
    try {
      const glyph = icon("file");
      assert.equal(glyph.tagName, "svg");
      assert.equal(glyph.getAttribute("aria-hidden"), "true");
      assert.equal(glyph.getAttribute("stroke"), "currentColor");
      assert.ok(glyph.children.length >= 1);
      assert.equal(icon("no-such-glyph").children.length >= 1, true, "falls back, never blank");
      assert.equal(checkMark().getAttribute("class"), "check");
    } finally {
      dom.restore();
    }
  });
});

describe("the live surface while you drive", () => {
  const UI = join(dirname(fileURLToPath(import.meta.url)), "../../../src/ui");
  const source = (name: string) => readFileSync(join(UI, name), "utf8");

  it("calls the live surface an application while you drive, and a picture otherwise", () => {
    assert.equal(screenLabel("driving", "www.wikipedia.org"), "Its screen — you’re driving");
    assert.equal(screenLabel("live", "www.wikipedia.org"), "What your bot sees: www.wikipedia.org");
    assert.equal(screenLabel("live", null), "What your bot sees");
    const panel = source("live/panel.ts");
    assert.match(panel, /setAttribute\("role", driving \? "application" : "img"\)/);
    assert.match(panel, /this\.canvas\.tabIndex = driving \? 0 : -1/);
  });

  it("shows one line saying the screen takes the keyboard and how to leave", () => {
    assert.equal(DRIVING_HINT, "Click the screen, then type. Esc returns control.");
    assert.match(source("live/panel.ts"), /this\.hintText\.hidden = !driving/);
  });

  it("gives the driving state a visible focus ring, on the frame not the canvas", () => {
    const css = source("task.css");
    const rule = css.slice(css.indexOf(".view.human:has(.screen canvas:focus)"));
    assert.ok(rule.startsWith(".view.human:has(.screen canvas:focus) {"), "the rule exists");
    assert.match(rule.slice(0, 120), /box-shadow: var\(--focus-ring\)/, "the app's own ring");
    // `:focus`, not `:focus-visible` — this focus arrives from a click, and a
    // click is how a person takes the screen.
    assert.equal(css.includes(".view.human:has(.screen canvas:focus-visible)"), false);
    // And no second ember rectangle inside the frame that is already ember.
    assert.match(css, /\.view:not\(\.human\) \.screen canvas:focus-visible \{/);
    assert.equal(css.includes("outline: none"), false, "a ring is moved, never deleted");
  });
});
