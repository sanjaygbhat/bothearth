/**
 * After control is returned, the task page must say why — password/otp
 * cleared, hold expired, or nothing named — instead of looking like a silent success.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCsrfToken, setCsrfToken } from "../../../src/ui/api.ts";
import { resetSession } from "../../../src/ui/session.ts";
import { releaseControl, releaseReturnedCopy } from "../../../src/ui/takeover.ts";
import { TaskView } from "../../../src/ui/task.ts";
import { type FakeElement, installDom, settle } from "./fake-dom.ts";

const AT = "2026-09-12T10:02:00.000Z";
const SESSION = { ok: true, csrf: "c", spend_cap_usd: 2, execution_mode: "standalone" };

const PASSWORD_LINE =
  "You gave control back. The bot cleared the password field before continuing.";
const OTP_LINE = "You gave control back. The bot cleared the code field before continuing.";
const EXPIRED_LINE = "Control returned because the hold expired.";
const NO_REASON_LINE = "You gave control back.";

type Json = Record<string, unknown>;

describe("releaseReturnedCopy maps only reasons that exist", () => {
  it("names a cleared password field", () => {
    assert.equal(releaseReturnedCopy("password"), PASSWORD_LINE);
  });

  it("names a cleared code field", () => {
    assert.equal(releaseReturnedCopy("otp"), OTP_LINE);
  });

  it("names an expired hold", () => {
    assert.equal(releaseReturnedCopy("expired"), EXPIRED_LINE);
  });

  it("says control came back when no reason is named", () => {
    assert.equal(releaseReturnedCopy(undefined), NO_REASON_LINE);
    assert.equal(releaseReturnedCopy(null), NO_REASON_LINE);
    assert.equal(releaseReturnedCopy(""), NO_REASON_LINE);
  });

  it("does not invent copy for an unknown reason", () => {
    assert.equal(releaseReturnedCopy("sign_in"), NO_REASON_LINE);
    assert.equal(releaseReturnedCopy("password_field"), NO_REASON_LINE);
  });
});

describe("releaseControl keeps the reason on a successful handback", () => {
  async function withFetch<T>(payload: unknown, run: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    const csrf = getCsrfToken();
    setCsrfToken("task-csrf");
    globalThis.fetch = (async () => Response.json(payload)) as typeof fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = original;
      setCsrfToken(csrf);
    }
  }

  it("passes cleared.reason through when the hold is already agent", async () => {
    await withFetch({ takeover: { state: "agent" }, cleared: { reason: "password" } }, async () => {
      const released = await releaseControl("tk_1");
      assert.deepEqual(released, { ok: true, cleared: { reason: "password" } });
    });
  });

  it("treats HTTP 200 blocked_by on an agent hold as the same reason", async () => {
    await withFetch({ takeover: { state: "agent" }, blocked_by: { kind: "otp" } }, async () => {
      const released = await releaseControl("tk_1");
      assert.deepEqual(released, { ok: true, cleared: { reason: "otp" } });
    });
  });

  it("returns no cleared payload when the daemon named none", async () => {
    await withFetch({ takeover: { state: "agent" } }, async () => {
      const released = await releaseControl("tk_1");
      assert.deepEqual(released, { ok: true });
    });
  });
});

function giveBack(root: FakeElement): FakeElement {
  const give = root
    .querySelectorAll("button")
    .find(
      (node) =>
        node.textContent?.includes("Give control back") && node.className.includes("primary"),
    );
  assert.ok(give, "Give control back is missing");
  return give;
}

function releaseLine(root: FakeElement): FakeElement | null {
  return root.querySelector(".release-reason");
}

async function mountHold(opts: {
  state: "human" | "paused";
  release: Json;
}): Promise<{ root: FakeElement; stop(): void }> {
  resetSession();
  const takeovers: Json = {
    takeovers: [
      { id: "tk_1", computer_id: "cmp_1", task_id: "t_1", state: opts.state, holder: "dev_me" },
    ],
  };
  const routes: Record<string, Json> = {
    "/api/v1/session": SESSION,
    "/api/v1/session/devices": { devices: [{ id: "dev_me", label: "This Mac", current: true }] },
    "/api/v1/tasks/t_1": {
      task: { id: "t_1", computer_id: "cmp_1", goal: "Sign in", status: "running", created_at: AT },
      steps: [{ kind: "task.started", body: {}, created_at: AT }],
    },
    "/api/v1/approvals": { approvals: [] },
    "/api/v1/takeovers": takeovers,
    "/api/v1/takeover/tk_1/release": opts.release,
  };
  const dom = installDom({ hash: "#/tasks/t_1" });
  const original = globalThis.fetch;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    const key = String(path).split("?")[0]!;
    if ((init?.method ?? "GET") === "POST") {
      if (key.endsWith("/release")) takeovers.takeovers = [];
      const body = routes[key];
      return body ? Response.json(body) : Response.json({ takeover: { state: "agent" } });
    }
    const body = routes[key];
    return body ? Response.json(body) : new Response("{}", { status: 404 });
  }) as typeof fetch;
  const view = new TaskView();
  const root = document.createElement("div") as unknown as FakeElement;
  await view.mount(root as unknown as HTMLElement, "t_1");
  await settle(8);
  return {
    root,
    stop() {
      view.unmount();
      globalThis.fetch = original;
      dom.restore();
    },
  };
}

describe("the task page shows the release reason", () => {
  it("shows the password line after a cleared-password release", async () => {
    const view = await mountHold({
      state: "human",
      release: { takeover: { state: "agent" }, cleared: { reason: "password" } },
    });
    try {
      giveBack(view.root).click();
      await settle(8);
      const line = releaseLine(view.root);
      assert.equal(line?.hidden, false);
      assert.equal(line?.textContent, PASSWORD_LINE);
    } finally {
      view.stop();
    }
  });

  it("shows the code-field line after a cleared-otp release", async () => {
    const view = await mountHold({
      state: "human",
      release: { takeover: { state: "agent" }, cleared: { reason: "otp" } },
    });
    try {
      giveBack(view.root).click();
      await settle(8);
      assert.equal(releaseLine(view.root)?.textContent, OTP_LINE);
    } finally {
      view.stop();
    }
  });

  it("shows the expired line after returning a paused hold", async () => {
    const view = await mountHold({
      state: "paused",
      release: { takeover: { state: "agent" } },
    });
    try {
      giveBack(view.root).click();
      await settle(8);
      assert.equal(releaseLine(view.root)?.textContent, EXPIRED_LINE);
    } finally {
      view.stop();
    }
  });

  it("shows the no-reason line when the daemon named none", async () => {
    const view = await mountHold({
      state: "human",
      release: { takeover: { state: "agent" } },
    });
    try {
      giveBack(view.root).click();
      await settle(8);
      const line = releaseLine(view.root);
      assert.equal(line?.hidden, false);
      assert.equal(line?.textContent, NO_REASON_LINE);
    } finally {
      view.stop();
    }
  });
});
