/**
 * Take control puts you in full screen and says so.
 *
 * The two are one gesture: the click that hands you the keyboard also hands
 * you the whole display, because a person who is about to type a password into
 * somebody else's website should not be doing it in a third of a column. This
 * covers the browser's Fullscreen API, the in-page fallback when the browser
 * refuses it, and the two ways out — Esc, which leaves full screen and keeps
 * the keyboard, and Give control back, which does both.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskView } from "../../../src/ui/task.ts";
import { CONTROL_TAKEN } from "../../../src/ui/takeover.ts";
import { installDom, settle, type FakeElement } from "./fake-dom.ts";

const AT = "2026-09-07T10:02:00.000Z";
type Json = Record<string, unknown>;

const HUMAN = {
  id: "tk_1",
  computer_id: "cmp_1",
  task_id: "t_1",
  state: "human",
  holder: "dev_me",
  expires_at: new Date(Date.now() + 581_000).toISOString(),
};

/**
 * A daemon that grants the keyboard on request, and a browser whose Fullscreen
 * API does whatever this test needs it to do.
 */
async function mount(options: { fullscreen: "grants" | "denies" | "absent" }) {
  const dom = installDom({ hash: "#/tasks/t_1" });
  const posts: string[] = [];
  let takeovers: Json[] = [];
  let release: "agent" | "human" = "agent";

  const routes: Record<string, Json> = {
    "/api/v1/session": { ok: true, csrf: "c", spend_cap_usd: 2, execution_mode: "standalone" },
    "/api/v1/session/devices": { devices: [{ id: "dev_me", label: "This Mac", current: true }] },
    "/api/v1/tasks/t_1": {
      task: { id: "t_1", computer_id: "cmp_1", goal: "Sign in", status: "running", created_at: AT },
      steps: [{ kind: "task.started", body: {}, created_at: AT }],
    },
    "/api/v1/approvals": { approvals: [] },
  };

  const original = globalThis.fetch;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    const key = String(path).split("?")[0]!;
    if ((init?.method ?? "GET") === "POST") {
      posts.push(key);
      if (key === "/api/v1/takeover/request") {
        return Response.json({ takeover: { takeover_id: "tk_1", state: "takeover_requested" } });
      }
      if (key === "/api/v1/takeover/tk_1/acquire") {
        takeovers = [HUMAN];
        return Response.json({ ok: true });
      }
      if (key === "/api/v1/takeover/tk_1/release") {
        if (release === "agent") takeovers = [];
        return Response.json({ takeover: { state: release } });
      }
      return Response.json({ ok: true });
    }
    if (key === "/api/v1/takeovers") return Response.json({ takeovers });
    const body = routes[key];
    return body ? Response.json(body) : new Response("{}", { status: 404 });
  }) as typeof fetch;

  const view = new TaskView();
  const root = document.createElement("div") as unknown as FakeElement;
  await view.mount(root as unknown as HTMLElement, "t_1");
  await settle();

  // The Fullscreen API, as this browser has it. The panel root is the element
  // the app asks to fill the display.
  const side = root.querySelector(".task-side")! as unknown as Record<string, unknown>;
  const doc = document as unknown as Record<string, unknown>;
  const asked: string[] = [];
  if (options.fullscreen !== "absent") {
    side["requestFullscreen"] = async () => {
      asked.push("enter");
      if (options.fullscreen === "denies") throw new Error("Permission denied");
      doc["fullscreenElement"] = side;
    };
  }
  doc["exitFullscreen"] = async () => {
    asked.push("exit");
    doc["fullscreenElement"] = null;
  };

  return {
    view,
    root,
    posts,
    asked,
    /** `state` is what release comes back with — still `human` when sensitive. */
    setRelease(state: "agent" | "human") {
      release = state;
    },
    nativeFull: () => doc["fullscreenElement"] === side,
    grid: () => root.querySelector(".task-grid")!,
    notice: () => root.querySelector(".screen .notice")!,
    take: () =>
      root
        .querySelectorAll(".view-acts button")
        .find((node) => node.textContent.startsWith("Take control"))!,
    restore() {
      view.unmount();
      globalThis.fetch = original;
      dom.restore();
    },
  };
}

describe("Take control goes full screen and says so", () => {
  it("asks the browser for full screen and confirms control in the live view", async () => {
    const t = await mount({ fullscreen: "grants" });
    try {
      t.take().click();
      await settle(8);

      assert.deepEqual(t.posts, [
        "/api/v1/takeover/request",
        "/api/v1/takeover/tk_1/acquire",
      ]);
      assert.deepEqual(t.asked, ["enter"], "the Fullscreen API was not asked");
      assert.equal(t.nativeFull(), true);
      assert.equal(t.grid().getAttribute("data-full"), "true");

      const notice = t.notice();
      assert.equal(notice.hidden, false);
      assert.equal(notice.textContent, CONTROL_TAKEN);
      assert.match(notice.textContent, /You have control\./);
      assert.match(notice.textContent, /Give control back \(⌘↩\)/);
      assert.equal(notice.getAttribute("aria-live"), "polite");
      assert.equal(notice.getAttribute("role"), "status");

      // Driving full screen leaves the countdown and one button, nothing else.
      const side = t.root.querySelector(".task-side")!;
      assert.equal(side.classList.contains("driving-full"), true);
      const bar = t.root.querySelector(".drive-bar")!;
      assert.equal(bar.hidden, false);
      assert.match(bar.querySelector(".lease")!.textContent, /Control returns to the bot in 9:4/);
      assert.deepEqual(
        bar.querySelectorAll("button").map((node) => node.textContent),
        ["Give control back"],
      );
    } finally {
      t.restore();
    }
  });

  it("falls back to the in-page full-bleed mode when the browser refuses", async () => {
    const t = await mount({ fullscreen: "denies" });
    try {
      t.take().click();
      await settle(8);
      assert.deepEqual(t.asked, ["enter"]);
      assert.equal(t.nativeFull(), false, "a denied request must not be reported as full screen");
      assert.equal(t.grid().getAttribute("data-full"), "true", "no in-page fallback");
      assert.equal(t.root.querySelector(".task-side")!.classList.contains("driving-full"), true);
      assert.equal(t.notice().textContent, CONTROL_TAKEN);
    } finally {
      t.restore();
    }
  });

  it("uses the in-page mode when the browser has no Fullscreen API at all", async () => {
    const t = await mount({ fullscreen: "absent" });
    try {
      t.take().click();
      await settle(8);
      assert.deepEqual(t.asked, []);
      assert.equal(t.grid().getAttribute("data-full"), "true");
      assert.equal(t.notice().textContent, CONTROL_TAKEN);
    } finally {
      t.restore();
    }
  });

  it("does the same for ⌘⇧T, which is the same acquire by another door", async () => {
    const t = await mount({ fullscreen: "grants" });
    try {
      (document as unknown as { fire(t: string, e: Json): void }).fire("keydown", {
        key: "T",
        metaKey: true,
        shiftKey: true,
      });
      await settle(8);
      assert.deepEqual(t.asked, ["enter"]);
      assert.equal(t.notice().textContent, CONTROL_TAKEN);
    } finally {
      t.restore();
    }
  });

  it("says why control did not land, in the same place, instead of nothing", async () => {
    const dom = installDom({ hash: "#/tasks/t_1" });
    const original = globalThis.fetch;
    globalThis.fetch = (async (path: string, init?: RequestInit) => {
      const key = String(path).split("?")[0]!;
      if (key === "/api/v1/takeover/request" && (init?.method ?? "GET") === "POST") {
        return new Response(JSON.stringify({ error: "E_TAKEOVER_BUSY" }), { status: 409 });
      }
      const body: Record<string, Json> = {
        "/api/v1/session": { ok: true, csrf: "c", execution_mode: "standalone" },
        "/api/v1/session/devices": { devices: [{ id: "dev_me", current: true }] },
        "/api/v1/tasks/t_1": {
          task: { id: "t_1", computer_id: "cmp_1", goal: "Sign in", status: "running", created_at: AT },
          steps: [],
        },
        "/api/v1/approvals": { approvals: [] },
        "/api/v1/takeovers": { takeovers: [] },
      };
      const found = body[key];
      return found ? Response.json(found) : new Response("{}", { status: 404 });
    }) as typeof fetch;
    const view = new TaskView();
    const root = document.createElement("div") as unknown as FakeElement;
    await view.mount(root as unknown as HTMLElement, "t_1");
    await settle();
    try {
      root
        .querySelectorAll(".view-acts button")
        .find((node) => node.textContent.startsWith("Take control"))!
        .click();
      await settle(8);
      const notice = root.querySelector(".screen .notice")!;
      assert.equal(notice.hidden, false, "a refused takeover said nothing on the screen");
      assert.match(notice.textContent, /still finishing a step/);
      assert.equal(notice.classList.contains("warn"), true);
      assert.equal(root.querySelector(".side-head .state")!.textContent, "Live");
    } finally {
      view.unmount();
      globalThis.fetch = original;
      dom.restore();
    }
  });
});

describe("the two ways out of driving full screen", () => {
  it("Esc leaves full screen and keeps the keyboard", async () => {
    const t = await mount({ fullscreen: "grants" });
    try {
      t.take().click();
      await settle(8);
      assert.equal(t.nativeFull(), true);

      (document as unknown as { fire(t: string, e: Json): void }).fire("keydown", {
        key: "Escape",
      });
      await settle(8);

      assert.deepEqual(t.asked, ["enter", "exit"]);
      assert.equal(t.grid().getAttribute("data-full"), "false");
      // Control is untouched: still driving, and no release was ever posted.
      assert.equal(t.posts.includes("/api/v1/takeover/tk_1/release"), false);
      assert.equal(t.root.querySelector(".side-head .state")!.textContent, "You are driving");
      assert.ok(t.root.querySelector(".driving"), "the driving card is gone");
    } finally {
      t.restore();
    }
  });

  it("Give control back leaves full screen and hands the keyboard over", async () => {
    const t = await mount({ fullscreen: "grants" });
    try {
      t.take().click();
      await settle(8);
      t.root.querySelector(".drive-bar button")!.click();
      await settle(8);

      assert.equal(t.posts.includes("/api/v1/takeover/tk_1/release"), true);
      assert.deepEqual(t.asked, ["enter", "exit"]);
      assert.equal(t.nativeFull(), false);
      assert.equal(t.grid().getAttribute("data-full"), "false");
      assert.equal(t.root.querySelector(".side-head .state")!.textContent, "Live");
      assert.equal(t.notice().hidden, true, "the confirmation outlived the control it confirmed");
    } finally {
      t.restore();
    }
  });

  it("keeps you full screen, and says why, when the page is still sensitive", async () => {
    const t = await mount({ fullscreen: "grants" });
    try {
      t.take().click();
      await settle(8);
      t.setRelease("human");
      t.root.querySelector(".drive-bar button")!.click();
      await settle(8);

      assert.equal(t.nativeFull(), true, "a refused release must not drop you out of full screen");
      assert.match(t.notice().textContent, /Finish that step or move off it/);
      assert.equal(t.notice().classList.contains("warn"), true);
    } finally {
      t.restore();
    }
  });
});
