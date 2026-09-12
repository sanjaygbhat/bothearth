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
    assert.match(phaseCopy("paused").note, /The login is on this screen, in its browser/);
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
    assert.match(waitingCopy("offline"), /Reconnecting automatically/);
    // After connect, a live surface with no picture is not still "starting".
    assert.equal(waitingCopy("live"), "No picture yet. Take control still works.");
    assert.equal(waitingCopy("live", "google.com/flights"), "google.com/flights");
    assert.equal(waitingCopy("connecting", "google.com/flights"), "Starting its computer…");
    assert.equal(
      waitingCopy("connecting", null, 8_000),
      "No picture yet from its computer. It may be busy loading a page.",
    );
    for (const phase of ["connecting", "paused", "offline", "live"] as PanelPhase[]) {
      assert.doesNotMatch(waitingCopy(phase), /frame|websocket|epoch/i);
    }
    assert.doesNotMatch(waitingCopy("connecting", null, 8_000), /frame|websocket|epoch/i);
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

  it("keeps Take control enabled before a first frame, and drops Starting once live", () => {
    const dom = installDom();
    const p = new LivePanel({ computerId: "cmp_1" });
    try {
      const take = p.root
        .querySelectorAll(".view-acts button")
        .find((node) => node.textContent.includes("Take control"))!;
      const waiting = p.root.querySelector(".waiting")!;
      assert.equal(take.disabled, false);
      assert.equal(take.hidden, false);
      assert.match(waiting.textContent, /Starting its computer/);

      p.setPhase("live");
      assert.equal(take.disabled, false, "no frame is not a reason to disable Take control");
      assert.equal(waiting.hidden, false);
      assert.equal(waiting.textContent, "No picture yet. Take control still works.");
      assert.doesNotMatch(waiting.textContent, /Starting its computer/);

      p.setUrl("https://google.com/flights?q=1");
      assert.equal(waiting.hidden, false);
      assert.equal(waiting.textContent, "google.com/flights");
    } finally {
      p.close();
      dom.restore();
    }
  });

  it("after a wait with no frame, tells the truth and offers Restart the picture", () => {
    const dom = installDom({ timers: "manual" });
    const p = new LivePanel({ computerId: "cmp_1" });
    try {
      const take = p.root
        .querySelectorAll(".view-acts button")
        .find((node) => node.textContent.includes("Take control"))!;
      const reconnect = p.root
        .querySelectorAll(".view-acts button")
        .find((node) => node.textContent === "Reconnect")!;
      const waiting = p.root.querySelector(".waiting")!;
      assert.match(waiting.textContent, /Starting its computer/);
      assert.equal(take.disabled, false);
      assert.equal(take.hidden, false);
      assert.equal(reconnect.hidden, true);

      dom.runTimers();
      assert.equal(
        waiting.textContent,
        "No picture yet from its computer. It may be busy loading a page.",
      );
      assert.doesNotMatch(waiting.textContent, /Starting its computer/);
      assert.equal(waiting.hidden, false);
      assert.equal(take.disabled, false);
      assert.equal(take.hidden, false);
      assert.equal(reconnect.hidden, true);
      assert.equal(reconnect.textContent, "Reconnect");

      dom.runTimers();
      assert.equal(reconnect.textContent, "Restart the picture");
      assert.equal(reconnect.hidden, false);
      assert.equal(take.disabled, false);
      assert.equal(take.hidden, false);
      assert.equal(waiting.hidden, false);
      assert.equal(
        waiting.textContent,
        "No picture yet from its computer. It may be busy loading a page.",
      );

      reconnect.click();
      const notice = p.root.querySelector(".screen .notice")!;
      assert.equal(notice.hidden, false);
      assert.equal(notice.textContent, "Restarting the picture…");
      assert.match(waiting.textContent, /Starting its computer/);
      assert.equal(reconnect.hidden, true);
      assert.equal(take.disabled, false);
    } finally {
      p.close();
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

  it("shows Give control back while a hold is paused", () => {
    const dom = installDom();
    try {
      const p = panel();
      const give = p.root.querySelector(".view-acts")!.querySelectorAll("button")
        .find((node) => node.textContent === "Give control back");
      assert.ok(give);
      assert.equal(give.hidden, true);
      p.setPhase("paused");
      assert.equal(give.hidden, false);
      p.setPhase("driving");
      assert.equal(give.hidden, false);
      p.setPhase("live");
      assert.equal(give.hidden, true);
    } finally {
      dom.restore();
    }
  });

  it("shows an expired control hold as paused after reconnecting", async () => {
    const dom = installDom();
    const p = new LivePanel({ computerId: "cmp_1" });
    try {
      p.connect();
      const live = (p as unknown as { live: { onMessage(data: string): Promise<void> } }).live;
      await live.onMessage(JSON.stringify({ v: 1, t: "mode", mode: "validating", epoch: 2 }));
      assert.equal(p.getPhase(), "paused");
      assert.equal(p.canvas.tabIndex, -1);
    } finally { p.close(); dom.restore(); }
  });

  it("keeps Give control back when the picture producer fails while driving", async () => {
    const dom = installDom();
    const p = new LivePanel({ computerId: "cmp_1" });
    try {
      p.setDriver(true);
      p.setPhase("driving");
      const live = (p as unknown as { live: { onMessage(data: string): Promise<void> } }).live;
      await live.onMessage(JSON.stringify({ v: 1, t: "producer", status: "restarting" }));
      const notice = p.root.querySelector(".screen .notice")!;
      assert.equal(p.getPhase(), "driving");
      assert.equal(notice.hidden, false);
      assert.equal(notice.textContent, "Restarting the picture…");
      await live.onMessage(JSON.stringify({ v: 1, t: "producer", status: "failed", reason: "exit 1" }));
      assert.equal(p.getPhase(), "driving");
      assert.equal(notice.textContent, "The picture stopped. Give control back and take it again.");
      assert.equal(notice.classList.contains("warn"), true);
      const give = p.root.querySelector(".view-acts")!.querySelectorAll("button")
        .find((node) => node.textContent === "Give control back");
      assert.equal(give?.hidden, false);
    } finally { p.close(); dom.restore(); }
  });

  it("keeps driving and says Reconnecting… when the socket drops while this window holds the grant", async () => {
    const dom = installDom();
    const p = new LivePanel({ computerId: "cmp_1" });
    try {
      p.setDriver(true);
      p.setPhase("driving");
      const live = (p as unknown as {
        live: { cb: { onError(err: Error, recovery?: { held: boolean }): void }; onFrame(): void };
      }).live;
      live.cb.onError(new Error("Reconnecting…"), { held: true });
      assert.equal(p.getPhase(), "driving");
      const notice = p.root.querySelector(".screen .notice")!;
      assert.equal(notice.hidden, false);
      assert.equal(notice.textContent, "Reconnecting…");
      const reconnect = p.root
        .querySelectorAll(".view-acts button")
        .find((node) => node.textContent === "Reconnect");
      assert.equal(reconnect?.hidden, true);
      assert.doesNotMatch(p.root.querySelector(".side-head .state")!.textContent, /Not connected/);
      live.cb.onFrame();
      assert.equal(p.getPhase(), "driving");
      assert.equal(notice.hidden, true);
    } finally { p.close(); dom.restore(); }
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
      assert.equal(buttons.length, 4, "take, give control back, full screen, reconnect");
      p.setActionsVisible(false, false);
      assert.equal(buttons[0]?.hidden, true);
      assert.equal(buttons[2]?.hidden, true);
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
      const full = p.root.querySelectorAll(".view-acts button").find((node) => node.textContent === "Full screen")!;
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
    assert.equal(DRIVING_HINT, "Click the computer to type. Ctrl+Alt+T opens Terminal; Ctrl+Alt+E opens Files. Use Return control when finished.");
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
