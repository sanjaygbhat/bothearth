import assert from "node:assert/strict";
import { test } from "node:test";
import { all, byText, installDom, settle, type FakeElement } from "./fake-dom.ts";

const json = (body: unknown, status = 200) =>
  Response.json(body as Record<string, unknown>, { status });

type World = {
  origin: string | null;
  devices: Array<{ id: string; label: string; current: boolean; expires_at: string }>;
  mutations: string[];
  copied: number;
  pairing?: { url: string; expires_at: string };
};

async function mountDevices(world: World) {
  const dom = installDom({ timers: "manual", hash: "#/settings", fetch: async (path, init) => {
    if (init?.method === "POST" || init?.method === "DELETE") world.mutations.push(path);
    if (path.endsWith("/pairings")) {
      return json(
        world.pairing ?? {
          url: "https://fixture.example/#bootstrap=uZ4v1Qk9tE3sLp7WmXyB2cD8hR5aN0gF",
          expires_at: new Date(Date.now() + 9.5 * 60_000).toISOString(),
        },
        201,
      );
    }
    if (path.startsWith("/api/v1/session/devices/")) {
      const id = path.split("/").pop() as string;
      world.devices = world.devices.filter((d) => d.id !== id);
      return json({ ok: true });
    }
    if (path.endsWith("/devices")) return json({ devices: world.devices });
    if (path.endsWith("/logout")) return json({ ok: true });
    return json({ ok: true, public_origin: world.origin, origin: world.origin });
  } });
  (globalThis as { navigator: { clipboard: { writeText(v: string): Promise<void> } } }).navigator = {
    clipboard: {
      writeText: async () => {
        world.copied += 1;
      },
    },
  };
  const module = await import(`../../../src/ui/devices.ts?case=${Math.random()}`);
  const pane = dom.document.createElement("div");
  dom.document.body.append(pane);
  const dispose = module.renderDevices(pane);
  await settle();
  await settle();
  return { dom, pane, dispose };
}

test("a phone link is never made or copied without a click, and it clears itself", async () => {
  const world: World = {
    origin: "https://fixture.example",
    devices: [
      { id: "owner", label: "This Mac", current: true, expires_at: new Date().toISOString() },
      { id: "phone", label: "Phone", current: false, expires_at: new Date().toISOString() },
    ],
    mutations: [],
    copied: 0,
  };
  const { dom, pane, dispose } = await mountDevices(world);
  try {
    assert.deepEqual(world.mutations, [], "showing the section asks for nothing");
    assert.equal(world.copied, 0);

    const issue = byText(pane, "Connect a phone") as FakeElement;
    assert.equal(issue.disabled, false, "a private HTTPS address makes pairing possible");
    issue.fire("click");
    issue.fire("click");
    await settle();
    await settle();
    assert.deepEqual(world.mutations, ["/api/v1/session/pairings"], "a double click makes one link");
    assert.equal(world.copied, 0, "the link is never put on the clipboard by itself");

    const link = all(pane).find((n) => n.value.includes("bootstrap=")) as FakeElement;
    assert.ok(link, "the link is shown so it can be read or pasted");
    const svg = all(pane).find((n) => n.tagName === "svg") as FakeElement;
    assert.ok(svg, "a scannable code is drawn beside it");
    assert.equal(svg.getAttribute("role"), "img");
    assert.match(svg.getAttribute("aria-label") ?? "", /phone/i);
    assert.match(
      all(pane).map((n) => n.textContent).join(" "),
      /Expires in 9:\d\d · one use only/,
      "the ten-minute expiry counts down in words",
    );

    (byText(pane, "Copy connection link") as FakeElement).fire("click");
    await settle();
    assert.equal(world.copied, 1, "copying takes an explicit click");

    dom.runTimers();
    await settle();
    assert.equal(link.value, "", "the link leaves the page when it expires");
    assert.equal(all(pane).some((n) => n.tagName === "svg"), false, "and so does the code");
    assert.match(all(pane).map((n) => n.textContent).join(" "), /That link expired/);
  } finally {
    dispose();
    dom.restore();
  }
});

test("on a link only this computer can open, the button explains instead of sitting dead", async () => {
  const world: World = { origin: "http://127.0.0.1:7803", devices: [], mutations: [], copied: 0 };
  const { dom, pane, dispose } = await mountDevices(world);
  try {
    const issue = byText(pane, "Connect a phone") as FakeElement;
    assert.equal(issue.disabled, true);
    const text = all(pane).map((n) => n.textContent).join(" ");
    assert.match(text, /Your phone needs a private HTTPS address to reach this Mac/);
    assert.match(text, /Nothing paired yet\./);
    const guide = all(pane).find((n) => n.tagName === "A" && !n.hidden) as FakeElement;
    assert.match(guide.href, /^https:\/\/github\.com\/.*REMOTE-DEPLOY\.md$/);
    assert.equal(guide.rel, "noopener noreferrer");
  } finally {
    dispose();
    dom.restore();
  }
});

test("revoking one phone touches only that phone", async () => {
  const world: World = {
    origin: "https://fixture.example",
    devices: [
      { id: "owner", label: "This Mac", current: true, expires_at: new Date().toISOString() },
      { id: "phone", label: "Phone", current: false, expires_at: new Date().toISOString() },
    ],
    mutations: [],
    copied: 0,
  };
  const { dom, pane, dispose } = await mountDevices(world);
  try {
    assert.ok(byText(pane, "Sign out on this device"), "the current device signs itself out, never revokes");
    (byText(pane, "Revoke access") as FakeElement).fire("click");
    await settle();
    await settle();
    assert.ok(world.mutations.includes("/api/v1/session/devices/phone"));
    assert.equal(world.mutations.includes("/api/v1/session/logout"), false);
    assert.equal(world.devices.length, 1);
    assert.match(all(pane).map((n) => n.textContent).join(" "), /can no longer reach ModelBot/);
  } finally {
    dispose();
    dom.restore();
  }
});

test("a link the daemon cannot make privately is refused in plain words", async () => {
  const world: World = {
    origin: "https://fixture.example",
    devices: [],
    mutations: [],
    copied: 0,
    pairing: { url: "http://fixture.example/#bootstrap=x", expires_at: new Date(Date.now() + 60_000).toISOString() },
  };
  const { dom, pane, dispose } = await mountDevices(world);
  try {
    (byText(pane, "Connect a phone") as FakeElement).fire("click");
    await settle();
    await settle();
    assert.match(
      all(pane).map((n) => n.textContent).join(" "),
      /That link cannot be made right now/,
    );
    assert.equal(all(pane).some((n) => n.value.includes("bootstrap=")), false);
  } finally {
    dispose();
    dom.restore();
  }
});
