import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  approvalDeadline,
  decideApproval,
  describeApproval,
  destinationHost,
  destinationKind,
  renderApproval,
  sanitizePayload,
  type PendingApproval,
} from "../../../src/ui/approval.ts";
import { getCsrfToken, setCsrfToken } from "../../../src/ui/api.ts";
import { installDom } from "./fake-dom.ts";

const UI = join(dirname(fileURLToPath(import.meta.url)), "../../../src/ui");

function pending(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approval_id: "apv_1",
    tool: "files_write",
    gate: "external_send",
    args: { path: "/workspace/notes/flights.md", content: "JetBlue 915 — $188" },
    bind: {
      task_id: "t_1",
      control_epoch: 3,
      origin: "about:blank",
      action_hash: "deadbeef",
      expires: new Date(Date.now() + 94_000).toISOString(),
    },
    created_at: new Date().toISOString(),
    ...over,
  };
}

describe("approval copy — no gate names, no raw JSON", () => {
  it("asks a plain question and says why it is being asked", () => {
    const copy = describeApproval(pending());
    // One noun. This ask is gated `external_send`, so the
    // file is leaving its computer for the Mac — and every sentence on the card
    // now says "your Mac", where it used to say three different things.
    assert.equal(copy.title, "Put “flights.md” on your Mac?");
    assert.equal(copy.kind, "mac");
    assert.equal(copy.place, "your Mac");
    assert.match(copy.what, /first time it has sent anything out of its computer/);
    assert.doesNotMatch(copy.what, /flights\.md/, "the name belongs on the destination row, said once");
    assert.equal(copy.destName, "flights.md");
    assert.equal(copy.destNote, "Leaves its computer for your Mac");
    assert.equal(copy.discloseLabel, "Show exactly what it will write");
  });

  it("names a form submit as submitting the form, not opening a site", () => {
    const copy = describeApproval(
      pending({
        tool: "browser_type",
        gate: "new_domain",
        args: { text: "hello", submit: true },
        bind: { ...pending().bind, origin: "https://httpbin.org/post" },
      }),
    );
    assert.equal(copy.title, "Submit this form to httpbin.org?");
    assert.match(copy.what, /submit this form to httpbin.org/);
    assert.doesNotMatch(copy.title, /open a new site|Open httpbin/i);
    assert.doesNotMatch(copy.what, /open httpbin/i);
  });

  it("names the real destination for a site this task has not been allowed", () => {
    const copy = describeApproval(
      pending({
        tool: "browser_navigate",
        gate: "new_domain",
        args: { url: "https://jetblue.com/book?flight=915" },
        bind: { ...pending().bind, navigation_url: "https://jetblue.com/book" },
      }),
    );
    assert.equal(copy.title, "Open jetblue.com?");
    assert.equal(copy.destName, "jetblue.com");
    assert.equal(copy.destNote, "Leaves its computer for jetblue.com");
  });

  /*
   * The card claimed "This is the first time your bot has opened this site" on
   * a per-task grant for mail.google.com, to a person whose own profile was
   * signed in there and who had watched it work in eight earlier tasks. The
   * grant is scoped to one task; the sentence now says only that.
   */
  it("says the grant is for this task, not that the site is new", () => {
    const copy = describeApproval(
      pending({
        tool: "browser_navigate",
        gate: "new_domain",
        args: { url: "https://mail.google.com/mail/u/0/#settings/filters" },
        bind: { ...pending().bind, navigation_url: "https://mail.google.com/mail/u/0/" },
      }),
    );
    assert.equal(copy.what, "Your bot wants to open mail.google.com for this task.");
    for (const line of [copy.what, copy.destNote, copy.title]) {
      assert.doesNotMatch(line, /first time|never|not used before|has not opened/i, line);
    }
    assert.equal(copy.rememberLabel, null, "no grant was on offer");
    assert.equal(
      describeApproval(
        pending({
          tool: "browser_navigate",
          gate: "new_domain",
          can_remember: true,
          args: { url: "https://mail.google.com/mail/u/0/" },
          bind: { ...pending().bind, navigation_url: "https://mail.google.com/mail/u/0/" },
        }),
      ).rememberLabel,
      "Allow this site for the task",
      "the per-task grant is still on offer beside Allow once",
    );
  });

  it("never prints an internal name in anything a person reads", () => {
    const banned =
      /new_domain|external_send|secret_entry|action_hash|control_epoch|computer_id|browser_navigate|files_write|takeover epoch|daemon|CSRF/i;
    for (const gate of [
      "new_domain",
      "external_send",
      "payment",
      "upload",
      "delete",
      "secret_entry",
    ]) {
      for (const tool of ["browser_navigate", "files_write", "shell_exec", "mystery_tool"]) {
        const copy = describeApproval(pending({ gate, tool }));
        for (const line of [copy.title, copy.what, copy.destName, copy.destNote, copy.discloseLabel]) {
          assert.doesNotMatch(line, banned, `${tool}/${gate}: ${line}`);
        }
      }
    }
  });

  it("treats loopback and non-http destinations as staying on this Mac", () => {
    assert.equal(destinationHost(pending({ args: { url: "http://127.0.0.1:7802/x" } })), null);
    assert.equal(destinationHost(pending({ args: { url: "file:///etc/passwd" } })), null);
    assert.equal(destinationHost(pending({ args: { url: "https://a.example.com/x" } })), "a.example.com");
  });

  it("redacts anything credential-shaped from the payload it will show", () => {
    const clean = sanitizePayload({
      url: "https://example.com",
      password: "hunter2",
      headers: { Authorization: "Bearer abc", accept: "json" },
      api_key: "k",
    }) as Record<string, unknown>;
    assert.equal(clean.url, "https://example.com");
    assert.equal(clean.password, "••••••");
    assert.equal(clean.api_key, "••••••");
    assert.deepEqual(clean.headers, { Authorization: "••••••", accept: "json" });
  });

});

describe("approval surface", () => {
  it("keeps the action row out of the scrolling body", () => {
    const dom = installDom();
    try {
      const surface = renderApproval(pending(), { onDecide() {} });
      const body = surface.root.querySelector(".approval-body");
      const actions = surface.root.querySelector(".approval-actions");
      assert.ok(body && actions, "the card has a body and an action row");
      assert.equal(body.contains(actions), false, "the actions are not inside the scroller");
      assert.equal(actions.parentNode, surface.root);
      // ONE countdown, and it is the attention banner's, which reads the
      // daemon's real TTL. The card used to carry a second, clamped one that
      // said 1:29 while the banner said 14:28.
      assert.equal(actions.querySelector(".timer"), null);
      assert.doesNotMatch(surface.root.textContent, /left — then it stops/);
      const buttons = actions.querySelectorAll("button");
      assert.deepEqual(
        buttons.map((b) => b.textContent.replace(/\s+/g, " ").trim()),
        ["Don’t allow esc", "Allow once ↩"],
      );
      surface.destroy();
    } finally {
      dom.restore();
    }
  });

  it("declares no scroller or viewport cap that could clip it", () => {
    const css = readFileSync(join(UI, "task.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string): string => {
      const at = css.indexOf(`${selector} {`);
      assert.ok(at >= 0, `${selector} missing from task.css`);
      return css.slice(at, css.indexOf("}", at));
    };
    assert.match(rule(".approval-body"), /overflow:\s*auto/);
    assert.match(rule(".approval-actions"), /flex:\s*0 0 auto/);
    // The card may shrink; only its body scrolls.
    assert.match(rule(".approval"), /flex:\s*0 1 auto/);
    assert.doesNotMatch(css, /max-height:[^;]*\d+d?v(h|min|max)/);
  });

  it("does not put the payload in the DOM until it is asked for", () => {
    const dom = installDom();
    try {
      const req = pending();
      const surface = renderApproval(req, { onDecide() {} });
      assert.equal(surface.root.querySelector(".payload"), null);
      assert.doesNotMatch(surface.root.textContent, /JetBlue 915/);

      const disclose = surface.root.querySelector(".disclose");
      assert.ok(disclose);
      assert.equal(disclose.getAttribute("aria-expanded"), "false");
      disclose.click();
      assert.equal(disclose.getAttribute("aria-expanded"), "true");
      assert.match(surface.root.querySelector(".payload")?.textContent ?? "", /JetBlue 915/);

      disclose.click();
      assert.equal(surface.root.querySelector(".payload"), null);
      surface.destroy();
    } finally {
      dom.restore();
    }
  });

  it("pauses on expiry and never approves", () => {
    const dom = installDom();
    try {
      const decisions: string[] = [];
      let expired = 0;
      const req = pending({
        bind: { ...pending().bind, expires: new Date(Date.now() - 1000).toISOString() },
      });
      const surface = renderApproval(req, {
        onDecide: (d) => decisions.push(d),
        onExpire: () => {
          expired += 1;
        },
      });
      assert.equal(expired, 1);
      assert.deepEqual(decisions, [], "expiry decides nothing");
      const buttons = surface.root.querySelectorAll(".approval-actions button");
      for (const button of buttons) assert.equal(button.disabled, true);
      buttons[1]?.click();
      surface.handleKey({ key: "Enter", preventDefault() {} } as unknown as KeyboardEvent);
      assert.deepEqual(decisions, [], "no decision after the countdown ran out");
      surface.destroy();
    } finally {
      dom.restore();
    }
  });

  it("maps Esc to Don’t allow and Enter to Allow once (§2.7)", () => {
    const dom = installDom();
    try {
      const decisions: string[] = [];
      const surface = renderApproval(pending(), { onDecide: (d) => decisions.push(d) });
      const key = (k: string) =>
        surface.handleKey({ key: k, preventDefault() {}, target: null } as unknown as KeyboardEvent);
      assert.equal(key("Escape"), true);
      assert.equal(key("Enter"), true);
      assert.equal(key("a"), false);
      assert.deepEqual(decisions, ["deny", "allow_once"]);
      surface.destroy();
    } finally {
      dom.restore();
    }
  });

  it("announces itself assertively, not politely", () => {
    const dom = installDom();
    try {
      const surface = renderApproval(pending(), { onDecide() {} });
      assert.equal(surface.root.getAttribute("role"), "alertdialog");
      assert.equal(surface.root.getAttribute("aria-live"), null);
      const labelled = surface.root.getAttribute("aria-labelledby");
      const described = surface.root.getAttribute("aria-describedby");
      assert.ok(labelled && surface.root.querySelector(`#${labelled}`));
      assert.ok(described && surface.root.querySelector(`#${described}`));
      surface.destroy();
    } finally {
      dom.restore();
    }
  });
});

describe("approval decision", () => {
  it("sends the daemon’s own three decisions, bound, with the session CSRF", async () => {
    const originalFetch = globalThis.fetch;
    const csrf = getCsrfToken();
    setCsrfToken("task-csrf");
    const seen: Array<{ path: string; body: unknown; csrf: string | null }> = [];
    globalThis.fetch = (async (path: string, init: RequestInit) => {
      seen.push({
        path: String(path),
        body: JSON.parse(String(init.body)),
        csrf: new Headers(init.headers).get("X-CSRF-Token"),
      });
      return Response.json({ approval: { id: "apv_1" } });
    }) as typeof fetch;
    try {
      const req = pending();
      await decideApproval(req.approval_id, "allow_once", req.bind);
      await decideApproval(req.approval_id, "deny", req.bind);
      assert.deepEqual(
        seen.map((s) => s.path),
        ["/api/v1/approvals/apv_1", "/api/v1/approvals/apv_1"],
      );
      assert.equal(seen[0]?.csrf, "task-csrf");
      assert.deepEqual(seen[0]?.body, { decision: "allow_once", bind: req.bind });
      assert.deepEqual(seen[1]?.body, { decision: "deny", bind: req.bind });
    } finally {
      globalThis.fetch = originalFetch;
      setCsrfToken(csrf);
    }
  });
});

describe("approval heading length", () => {
  it("keeps the question short and lets the destination row carry a long name", () => {
    const long = describeApproval(
      pending({ args: { path: "/workspace/notes/SFO-JFK cheapest direct flights.md" } }),
    );
    assert.equal(long.title, "Put a file on your Mac?");
    assert.ok(long.title.length <= 40, "a heading is a question, not a file path");
    assert.equal(long.destName, "SFO-JFK cheapest direct flights.md");
    const short = describeApproval(pending({ args: { path: "notes.md" } }));
    assert.equal(short.title, "Put “notes.md” on your Mac?");
  });
});

/** A first-visit navigation ask, the shape the remembered grant is offered on. */
function navigation(over: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approval_id: "apv_1",
    tool: "browser_navigate",
    gate: "new_domain",
    args: { url: "https://www.google.com/flights" },
    bind: {
      task_id: "t_1",
      control_epoch: 1,
      origin: "https://www.google.com",
      action_hash: "beef",
      expires: new Date(Date.now() + 94_000).toISOString(),
    },
    created_at: new Date().toISOString(),
    can_remember: true,
    ...over,
  };
}

describe("the approval tells one story about one place", () => {
  it("uses exactly one noun for the destination, everywhere on the card", () => {
    // A permission ask names two places — what is crossing, and from where —
    // so the invariant is "one noun per place": the destination is called the
    // same thing in the heading, the body and the destination row, and the
    // source is always "its computer".
    const cases: Array<[PendingApproval, string, string[]]> = [
      [navigation(), "www.google.com", ["your Mac", "this Mac"]],
      [
        navigation({
          tool: "files_write", gate: "external_send", args: { path: "/w/a.md" },
          bind: { ...navigation().bind, origin: "about:blank" },
        }),
        "your Mac",
        ["this Mac", "on your computer"],
      ],
      [
        navigation({
          tool: "files_write", gate: "upload", args: { path: "/w/a.md" },
          bind: { ...navigation().bind, origin: "about:blank" },
        }),
        "its computer",
        ["your Mac", "on this Mac ·"],
      ],
    ];

    for (const [req, place, forbidden] of cases) {
      const copy = describeApproval(req);
      assert.equal(copy.place, place);
      const card = `${copy.title} ${copy.what} ${copy.destNote}`;
      assert.ok(card.includes(place), `the card calls the destination "${place}"`);
      for (const other of forbidden) {
        assert.ok(!card.includes(other), `"${card}" also calls it "${other}"`);
      }
      // The source, when one is named, is always the same noun.
      if (/leaves|out of|sent anything/i.test(card)) {
        assert.match(card, /its computer/, "the source is always 'its computer'");
      }
    }
  });

  it("decides the destination from the gate, not the tool", () => {
    assert.equal(destinationKind(navigation()), "site");
    assert.equal(
      destinationKind(
        navigation({ tool: "files_write", gate: "external_send", args: { path: "/w/a.md" },
                  bind: { ...navigation().bind, origin: "about:blank" } }),
      ),
      "mac",
    );
    assert.equal(
      destinationKind(
        navigation({ tool: "files_write", gate: "upload", args: { path: "/w/a.md" },
                  bind: { ...navigation().bind, origin: "about:blank" } }),
      ),
      "sandbox",
    );
  });

  it("draws the remembered grant only when the daemon offers it", () => {
    assert.equal(
      describeApproval(navigation()).rememberLabel,
      "Allow this site for the task",
    );
    assert.equal(describeApproval(navigation({ can_remember: false })).rememberLabel, null);
    // Never on a destination that is not a site — there is no origin to grant.
    assert.equal(
      describeApproval(
        navigation({ tool: "files_write", gate: "external_send", args: { path: "/w/a.md" },
                  bind: { ...navigation().bind, origin: "about:blank" } }),
      ).rememberLabel,
      null,
    );
  });

  it("posts allow_task from the third button, and keeps refusal neutral", () => {
    const dom = installDom();
    try {
      const decisions: string[] = [];
      const surface = renderApproval(navigation(), { onDecide: (d) => decisions.push(d) });
      const buttons = surface.root.querySelectorAll(".approval-actions .btnrow button");
      assert.equal(buttons.length, 3);

      // Warm danger beside a warm accent is the pairing the colour-blindness
      // note forbids, and refusing is the safe answer, not the destructive one.
      assert.equal(buttons[0]!.className, "btn", "Don’t allow is neutral ink");
      assert.equal(buttons[2]!.className, "btn primary", "only one button wears the ember");

      buttons[1]!.click();
      assert.deepEqual(decisions, ["allow_task"]);
      surface.destroy();
    } finally {
      dom.restore();
    }
  });

  it("reads the daemon's own deadline, and never invents one", () => {
    const at = Date.parse("2026-09-07T15:00:00.000Z");
    // The daemon's TTL is 900s. Clamping it to a 120s UI lease is what made the
    // card say 1:29 while the banner said 14:28.
    assert.equal(approvalDeadline(pending({ expires_at: new Date(at).toISOString() })), at);
    // `expires_at` outranks the bind, which is all the stored rows carry.
    const bind = { ...pending().bind, expires: new Date(at).toISOString() };
    assert.equal(approvalDeadline(pending({ bind })), at);
    assert.equal(approvalDeadline(pending({ bind: { ...bind, expires: "" } })), null);
  });
});
