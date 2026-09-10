import assert from "node:assert/strict";
import { test } from "node:test";
import { setCsrfToken } from "../../../src/ui/api.ts";
import { publishLicenceBadge, renderLicence } from "../../../src/ui/licence.ts";
import { currentSession, resetSession, type LicenceInfo } from "../../../src/ui/session.ts";
import { installDom, settle } from "./fake-dom.ts";

const unlicensed: LicenceInfo = { status: "unlicensed", required: true, label: "Add your licence key",
  account_url: "https://accounts.example.test/", covered_release: "release-new" };
const active: LicenceInfo = { ...unlicensed, status: "active", tier: "noncommercial", label: "Non-commercial" };

function badge(dom: ReturnType<typeof installDom>) {
  const bar = dom.document.createElement("header");
  bar.id = "titlebar";
  const link = dom.document.createElement("a");
  link.id = "tb-licence";
  link.href = "#/settings/licence";
  link.hidden = true;
  bar.append(link);
  dom.document.body.append(bar);
  return link;
}

test("activation clears private paste before posting and shows the saved tier beyond the pane", async () => {
  resetSession();
  setCsrfToken("operator-csrf");
  let finish!: (value: Response) => void;
  let stored = unlicensed;
  const posts: Array<{ url: string; body: unknown; csrf: string | null }> = [];
  const dom = installDom({ timers: "manual", fetch: async (url, init) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(init.body), csrf: new Headers(init.headers).get("X-CSRF-Token") });
      return new Promise<Response>((resolve) => { finish = resolve; });
    }
    return Response.json(url === "/api/v1/session" ? { ok: true, csrf: "operator-csrf", licence: stored } : stored);
  } });
  const chip = badge(dom);
  const dispose = renderLicence(dom.root as unknown as HTMLElement);
  try {
    await settle();
    assert.equal(chip.textContent, "Add key");
    const key = dom.root.querySelector("input")!;
    assert.equal(key.type, "password");
    assert.equal(key.getAttribute("autocomplete"), "off");
    assert.equal(dom.root.querySelector("a")!.href, "https://accounts.example.test/");
    key.value = "private.signed.certificate";
    key.fire("input");
    dom.root.querySelector("form")!.fire("submit");
    assert.equal(key.value, "", "remove certificate before any response arrives");
    assert.equal(key.disabled, true);
    assert.deepEqual(posts, [{ url: "/api/v1/licence/activate", body: { certificate: "private.signed.certificate" }, csrf: "operator-csrf" }]);
    assert.equal(dom.storage.size, 0);
    stored = active;
    finish(Response.json({ ...active, certificate: "should-never-be-rendered" }));
    await settle(8);
    assert.equal(chip.textContent, "Non-commercial");
    assert.equal(chip.hidden, false);
    assert.equal((await currentSession())?.licence?.tier, "noncommercial");
    assert.doesNotMatch(dom.document.body.textContent, /private\.signed|should-never-be-rendered/);
    key.value = "another.private.key";
    window.dispatchEvent(new Event("pagehide"));
    assert.equal(key.value, "");
    key.value = "discard.on.close";
    dispose();
    assert.equal(key.value, "");
    assert.equal(chip.textContent, "Non-commercial", "closing Settings does not remove the app status");
    publishLicenceBadge({ ...active, tier: "commercial", label: "Commercial" });
    assert.equal(chip.textContent, "Commercial");
  } finally { dispose(); dom.restore(); resetSession(); }
});

test("failed activation never echoes the submitted key or removes the existing tier", async () => {
  const secret = "secret.bad.certificate";
  const dom = installDom({ timers: "manual", fetch: async (_url, init) => Response.json(
    init?.method === "POST" ? { message: `Rejected key: ${secret}` } : active,
    { status: init?.method === "POST" ? 400 : 200 }),
  });
  const chip = badge(dom);
  const dispose = renderLicence(dom.root as unknown as HTMLElement);
  try {
    await settle();
    const key = dom.root.querySelector("input")!;
    key.value = secret;
    key.fire("input");
    dom.root.querySelector("form")!.fire("submit");
    await settle();
    assert.equal(key.value, "");
    assert.equal(chip.textContent, "Non-commercial");
    assert.match(dom.root.textContent, /Check that it covers this release/);
    assert.doesNotMatch(dom.root.textContent, /secret\.bad\.certificate/);
    assert.equal(dom.storage.size, 0);
  } finally { dispose(); dom.restore(); }
});

test("a rejected session refresh preserves successful activation without an unhandled rejection", async () => {
  resetSession();
  let refreshes = 0;
  const dom = installDom({ timers: "manual", fetch: async (url) => {
    if (url === "/api/v1/session/bootstrap") {
      refreshes += 1;
      throw new TypeError("Failed to fetch");
    }
    return Response.json(url === "/api/v1/licence/activate" ? active : unlicensed);
  } });
  const chip = badge(dom);
  const dispose = renderLicence(dom.root as unknown as HTMLElement);
  try {
    await settle();
    const key = dom.root.querySelector("input")!;
    key.value = "private.signed.certificate";
    key.fire("input");
    // A fresh operator link can arrive while Settings is open; its exchange may reject.
    location.hash = "#bootstrap=synthetic-one-time-link";
    dom.root.querySelector("form")!.fire("submit");
    await settle(8);
    assert.equal(refreshes, 1, "exercise the rejecting refresh path");
    assert.equal(key.value, "");
    assert.equal(chip.textContent, "Non-commercial");
    assert.match(dom.root.textContent, /Licence activated/);
    assert.doesNotMatch(dom.root.textContent, /Couldn’t activate/);
  } finally { dispose(); dom.restore(); resetSession(); }
});

test("legacy releases need no key; unavailable or unsafe account links are not followed", async () => {
  const legacy = { status: "legacy", required: false, label: "Existing release terms" };
  let reply: unknown = legacy;
  const requests: string[] = [];
  const dom = installDom({ timers: "manual", fetch: async (url) => {
    requests.push(url); return Response.json(reply);
  } });
  const chip = badge(dom);
  let dispose = renderLicence(dom.root as unknown as HTMLElement);
  try {
    await settle();
    assert.match(dom.root.textContent, /No key is required/);
    assert.equal(dom.root.querySelector("form")!.hidden, true);
    assert.equal(chip.hidden, true);
    assert.deepEqual(requests, ["/api/v1/licence"]);
    dispose(); dom.root.replaceChildren();
    reply = { ...unlicensed, account_url: "javascript:alert(1)" };
    dispose = renderLicence(dom.root as unknown as HTMLElement);
    await settle();
    const account = dom.root.querySelector("a")!;
    assert.equal(account.hidden, true);
    assert.equal(account.hasAttribute("href"), false);
  } finally { dispose(); dom.restore(); }
});

test("a disposed pane ignores a delayed response and an unavailable service offers retry", async () => {
  let finish!: (response: Response) => void;
  let delayed = true;
  const dom = installDom({ timers: "manual", fetch: async () => delayed
    ? new Promise<Response>(resolve => { finish = resolve; })
    : Response.json({ error: "not available" }, { status: 404 }),
  });
  const chip = badge(dom);
  publishLicenceBadge(active);
  let dispose = renderLicence(dom.root as unknown as HTMLElement);
  try {
    dispose();
    finish(Response.json(unlicensed));
    await settle();
    assert.equal(chip.textContent, "Non-commercial");
    dom.root.replaceChildren(); delayed = false;
    dispose = renderLicence(dom.root as unknown as HTMLElement);
    await settle();
    assert.match(dom.root.textContent, /need an app update/);
    assert.equal(dom.root.querySelector("form")!.hidden, true);
    assert.ok(dom.root.querySelectorAll("button").some(button => button.textContent === "Try again" && !button.hidden));
  } finally { dispose(); dom.restore(); }
});
