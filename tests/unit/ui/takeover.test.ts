import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  acquiredControl,
  declineControl,
  isActiveTakeover,
  isDriver,
  leaseText,
  releaseControl,
  rememberAcquired,
  renderDriving,
  renderNeedsYou,
  renderObserving,
  requestControl,
  STILL_SENSITIVE,
  takeoverReason,
  type TakeoverRow,
} from "../../../src/ui/takeover.ts";
import { getCsrfToken, setCsrfToken } from "../../../src/ui/api.ts";
import { actionable, installDom } from "./fake-dom.ts";

async function withFetch<T>(
  handler: (path: string, init: RequestInit) => unknown,
  run: (calls: string[]) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const csrf = getCsrfToken();
  setCsrfToken("task-csrf");
  const calls: string[] = [];
  globalThis.fetch = (async (path: string, init: RequestInit) => {
    calls.push(String(path));
    assert.equal(init.credentials, "same-origin");
    assert.equal(new Headers(init.headers).get("X-CSRF-Token"), "task-csrf");
    return Response.json(handler(String(path), init));
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
    setCsrfToken(csrf);
  }
}

describe("takeover wire (contracts unchanged)", () => {
  it("requests then acquires, and reuses a lease that is already human", async () => {
    let state = "requested";
    await withFetch(
      () => ({ takeover: { takeover_id: "tk_1", state, expires_at: "later", epoch: 4 } }),
      async (calls) => {
        assert.equal((await requestControl("c_1", "t_1"))?.takeover_id, "tk_1");
        assert.deepEqual(calls, [
          "/api/v1/takeover/request",
          "/api/v1/takeover/tk_1/acquire",
        ]);
        calls.length = 0;
        state = "human";
        const held = await requestControl("c_1", "t_1");
        assert.deepEqual(calls, ["/api/v1/takeover/request"], "no second grant");
        assert.equal(held, null, "a lease it did not acquire is not this page's to claim");
      },
    );
  });

  it("sends the computer and the task the daemon binds the lease to", async () => {
    await withFetch(
      (_path, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        assert.deepEqual(body, { computer_id: "c_1", reason: "ui", task_id: "t_1" });
        return { takeover: { takeover_id: "tk_1", state: "human" } };
      },
      async () => {
        await requestControl("c_1", "t_1");
      },
    );
  });

  it("reports a still-sensitive page as control NOT returned", async () => {
    const outcome: boolean[] = [];
    await withFetch(
      (path) =>
        path.endsWith("/release")
          ? { takeover: { state: outcome.length === 0 ? "human" : "agent" } }
          : {},
      async () => {
        outcome.push(await releaseControl("tk_1"));
        outcome.push(await releaseControl("tk_1"));
      },
    );
    assert.deepEqual(outcome, [false, true]);
  });

  it("declines through the daemon’s own endpoint", async () => {
    await withFetch(
      () => ({}),
      async (calls) => {
        await declineControl("tk_1");
        assert.deepEqual(calls, ["/api/v1/takeover/tk_1/decline"]);
      },
    );
  });

  it("knows which lease states mean a person is involved", () => {
    for (const state of ["takeover_requested", "human", "resume_validating", "paused"]) {
      assert.equal(isActiveTakeover(state), true, state);
    }
    for (const state of ["agent", "terminated", ""]) {
      assert.equal(isActiveTakeover(state), false, state);
    }
  });
});

describe("takeover copy", () => {
  it("says why in plain words, never the detector’s name", () => {
    // The detectors GUESS, and an `otp_field` guess on a signed-in Gmail
    // results page cost 3 m 26 s of a person's attention. The sentence says
    // what the bot thinks it is looking at, so being wrong is a thinkable
    // answer and "Not needed, continue" is the reply to it.
    assert.equal(
      takeoverReason("password_field"),
      "It thinks this is a password box, and it won’t type your password for you.",
    );
    assert.equal(
      takeoverReason("otp_field"),
      "It thinks this is a one-time-code field, and only you have the code.",
    );
    assert.match(takeoverReason("sign_in"), /It thinks this is a sign-in page/);
    assert.match(takeoverReason("captcha_iframe"), /prove you’re human/);
    assert.match(takeoverReason(undefined), /can’t do safely on its own/);
    for (const reason of ["password_field", "otp_field", "sign_in", "webauthn_prompt", "captcha_iframe", "nonsense"]) {
      assert.doesNotMatch(takeoverReason(reason), /_field|iframe|epoch|takeover|lease/i);
    }
  });

  it("states the STILL-sensitive hold without blaming the person", () => {
    assert.match(STILL_SENSITIVE, /Finish that step or move off it/);
    assert.doesNotMatch(STILL_SENSITIVE, /you (failed|must|cannot)/i);
  });
});

describe("who is driving", () => {
  const row = (over: Partial<TakeoverRow> = {}): TakeoverRow => ({
    id: "tk_1",
    computer_id: "cmp_1",
    task_id: "t_1",
    state: "human",
    ...over,
  });
  const me = { device: "dev_me", acquired: null };

  it("believes the holder the daemon names, and nobody else", () => {
    assert.equal(isDriver(row(), "dev_me", me), true);
    assert.equal(isDriver(row(), "dev_phone", me), false, "another device holds it");
    assert.equal(isDriver(row(), null, me), false, "an unnamed holder is not you");
    assert.equal(
      isDriver(row(), "dev_me", { device: null, acquired: null }),
      false,
      "a page that does not know which client it is cannot claim the keyboard",
    );
  });

  it("takes the page's own grant as proof, and only for that grant", () => {
    assert.equal(isDriver(row(), null, { device: null, acquired: "tk_1" }), true);
    assert.equal(isDriver(row(), null, { device: null, acquired: "tk_0" }), false);
  });

  it("is nobody's keyboard until the grant is actually human", () => {
    for (const state of ["takeover_requested", "resume_validating", "paused", "agent"]) {
      assert.equal(isDriver(row({ state }), "dev_me", me), false, state);
    }
    assert.equal(isDriver(null, "dev_me", me), false);
  });

  it("remembers its own grant across a reload of this tab, and forgets it on release", () => {
    const cells = new Map<string, string>();
    const saved = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => cells.get(key) ?? null,
        setItem: (key: string, value: string) => void cells.set(key, value),
        removeItem: (key: string) => void cells.delete(key),
      },
    });
    try {
      assert.equal(acquiredControl(), null);
      rememberAcquired("tk_1");
      assert.equal(acquiredControl(), "tk_1");
      assert.equal(isDriver(row(), null, { device: null, acquired: acquiredControl() }), true);
      rememberAcquired(null);
      assert.equal(acquiredControl(), null);
    } finally {
      if (saved) Object.defineProperty(globalThis, "sessionStorage", saved);
      else Reflect.deleteProperty(globalThis, "sessionStorage");
    }
  });

  it("survives a browser that refuses storage entirely", () => {
    Object.defineProperty(globalThis, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("storage is disabled");
      },
    });
    try {
      rememberAcquired("tk_1");
      assert.equal(acquiredControl(), null);
    } finally {
      Reflect.deleteProperty(globalThis, "sessionStorage");
    }
  });

  it("says how long control lasts, and what keeps it", () => {
    assert.equal(
      leaseText(581_000),
      "Control pauses in 9:41 unless you keep using it.",
    );
    assert.match(leaseText(0), /goes back to the bot/);
    assert.doesNotMatch(`${leaseText(581_000)} ${leaseText(0)}`, /lease|epoch|ttl/i);
  });
});

describe("takeover cards", () => {
  it("offers exactly one primary way in, and says what it costs the bot", () => {
    const dom = installDom();
    try {
      let taken = 0;
      const card = renderNeedsYou({ reason: "otp_field", onTake: () => (taken += 1) });
      assert.equal(card.root.getAttribute("role"), "alert");
      assert.match(card.root.textContent, /Your bot needs you/);
      assert.match(card.root.textContent, /one-time-code field/);
      const buttons = actionable(card.root);
      assert.equal(buttons.length, 1);
      assert.match(buttons[0]!.className, /primary/);
      buttons[0]!.click();
      assert.equal(taken, 1);
      card.focus();
      assert.equal(dom.document.activeElement, buttons[0]);
    } finally {
      dom.restore();
    }
  });

  it("tells the driver what the bot can and cannot see, and offers the way back", () => {
    const dom = installDom();
    try {
      const events: string[] = [];
      const card = renderDriving({
        onReturn: () => events.push("return"),
        onStop: () => events.push("stop"),
      });
      const text = card.root.textContent;
      assert.match(text, /You’re driving/);
      assert.match(text, /can’t see or operate the computer/);
      assert.match(text, /Messages you send below go to the bot/);
      assert.doesNotMatch(text, /epoch|lease|takeover_|control_epoch/i);

      const buttons = actionable(card.root);
      assert.deepEqual(
        buttons.map((b) => b.textContent.replace(/\s+/g, " ").trim()),
        ["Give control back ⌘↩", "Stop the task instead"],
      );
      buttons[0]!.click();
      buttons[1]!.click();
      assert.deepEqual(events, ["return", "stop"]);

      const lease = card.root.querySelectorAll("p.q")[1]!;
      assert.equal(lease.hidden, true, "no countdown until the daemon gives a deadline");
      card.setLease(581_000);
      assert.equal(lease.hidden, false);
      assert.match(lease.textContent, /Control pauses in 9:41/);
      assert.equal(lease.getAttribute("role"), null, "a per-second line is not announced");
      card.setLease(null);
      assert.equal(lease.hidden, true);

      const hold = card.root.querySelector("p.q[role=\"status\"]");
      assert.ok(hold);
      assert.equal(hold.hidden, true);
      card.setHold(STILL_SENSITIVE);
      assert.equal(hold.hidden, false);
      assert.equal(hold.textContent, STILL_SENSITIVE);
      card.setHold(null);
      assert.equal(hold.hidden, true);
    } finally {
      dom.restore();
    }
  });
});

describe("the window that is only watching", () => {
  it("says who has the keyboard, offers nothing to press, and is not an alarm", () => {
    const dom = installDom();
    try {
      const card = renderObserving();
      assert.match(card.root.textContent, /Someone else has control/);
      assert.match(card.root.textContent, /nothing you type here is sent/);
      assert.equal(card.root.getAttribute("role"), "status", "not an alert: nothing to do");
      assert.deepEqual(actionable(card.root), []);
      assert.doesNotMatch(card.root.textContent, /epoch|takeover_|device id/i);
    } finally {
      dom.restore();
    }
  });
});

describe("the needs-you card is not the titlebar strip", () => {
  const UI = join(dirname(fileURLToPath(import.meta.url)), "../../../src/ui");
  const source = (name: string) => readFileSync(join(UI, name), "utf8");

  it("keeps its own class, and says the sentence once", () => {
    // `.needs-you` is the titlebar strip in shell.css — `display: flex` — and a
    // card that inherits it lays itself out as a row.
    const takeover = source("takeover.ts");
    assert.match(takeover, /root\.className = "takeover-ask";/);
    assert.equal(/root\.className = "needs-you";/.test(takeover), false);
    assert.match(source("shell.css"), /\.needs-you \{/, "the strip keeps its class");
    assert.equal(/^\.needs-you[ ,{]/m.test(source("task.css")), false);
    assert.equal(/appendTextChild\(root, "div", "", "eyebrow"\)/.test(takeover), false);
    const rendered = takeover.match(/appendTextChild\([^)]*"Your bot needs you"/g) ?? [];
    assert.equal(rendered.length, 1, "the card renders that sentence exactly once");
  });
});
