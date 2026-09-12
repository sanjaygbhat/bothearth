/**
 * Download on a saved file is a same-origin attachment link. window.open of
 * an attachment URL closed a Playwright Chrome context and depends on popup
 * rules in an ordinary browser.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskView } from "../../../src/ui/task.ts";
import { installDom, type FakeElement } from "./fake-dom.ts";

type Json = Record<string, unknown>;

const ts = (minute: number, second = 0): string =>
  new Date(Date.UTC(2026, 8, 7, 10, minute, second)).toISOString();

function stubApi(routes: Record<string, Json>): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    const key = String(path).split("?")[0]!;
    if ((init?.method ?? "GET") === "HEAD") return new Response(null, { status: 200 });
    const body = routes[key];
    if (!body) return new Response("{}", { status: 404 });
    return Response.json(body);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function mount(task: Json, steps: Json[]) {
  const dom = installDom({ hash: "#/tasks/t_1" });
  const unstub = stubApi({
    "/api/v1/session": { ok: true, csrf: "c", spend_cap_usd: 2, execution_mode: "standalone" },
    "/api/v1/approvals": { approvals: [] },
    "/api/v1/takeovers": { takeovers: [] },
    "/api/v1/session/devices": { devices: [{ id: "dev_me", current: true }] },
    "/api/v1/tasks/t_1": {
      task: {
        id: "t_1",
        computer_id: "cmp_1",
        goal: "Save a file",
        created_at: ts(2),
        updated_at: ts(6),
        ...task,
      },
      steps,
    },
  });
  const view = new TaskView();
  const root = document.createElement("div") as unknown as FakeElement;
  await view.mount(root as unknown as HTMLElement, "t_1");
  await new Promise(setImmediate);
  return {
    root,
    restore: () => {
      view.unmount();
      unstub();
      dom.restore();
    },
  };
}

function spyOpen(): { opened: unknown[][]; restore: () => void } {
  const opened: unknown[][] = [];
  const win = window as unknown as { open: (...args: unknown[]) => null };
  const orig = win.open;
  win.open = (...args: unknown[]) => {
    opened.push(args);
    return null;
  };
  return { opened, restore: () => { win.open = orig; } };
}

describe("Download is a same-origin attachment link", () => {
  const steps = [
    { kind: "task.started", body: {}, created_at: ts(2) },
    {
      kind: "download.promoted",
      body: { path: "out/today.md", item_name: "today.md", bytes: 227 },
      created_at: ts(5),
    },
    { kind: "task.completed", body: { reason: "completed", summary: "Done." }, created_at: ts(6) },
  ];

  it("sets href and download on Download and Download all, and does not window.open", async () => {
    const t = await mount(
      {
        status: "completed",
        results_dir: "/Users/me/ModelBot/computers/cmp_1/workspace/out",
        summary: { steps: 1, sites: [], asks: 0, files_saved: ["out/today.md"], cost_usd: null },
      },
      steps,
    );
    const pop = spyOpen();
    try {
      const download = t.root.querySelector(".artifacts .file a")!;
      assert.equal(download.tagName, "A");
      assert.equal(download.className, "btn sm");
      assert.equal(download.textContent, "Download");
      assert.equal(download.href, "/api/v1/computers/cmp_1/files?path=out%2Ftoday.md");
      assert.equal(download.download, "today.md");
      assert.equal(download.target, "");
      assert.doesNotMatch(download.href, /token|csrf|session/i);

      const zip = t.root.querySelector(".artifacts-head a")!;
      assert.equal(zip.textContent, "Download all");
      assert.equal(zip.className, "btn sm");
      assert.equal(zip.href, "/api/v1/tasks/t_1/files.zip");
      assert.equal(zip.download, "t_1-files.zip");
      assert.doesNotMatch(zip.href, /token|csrf|session/i);

      download.click();
      zip.click();
      assert.deepEqual(pop.opened, []);
    } finally {
      pop.restore();
      t.restore();
    }
  });

  it("keeps Open as a new-tab / Finder action through the shell", async () => {
    const t = await mount(
      {
        status: "completed",
        results_dir: "/Users/me/ModelBot/computers/cmp_1/workspace/out",
        summary: { steps: 1, sites: [], asks: 0, files_saved: ["out/today.md"], cost_usd: null },
      },
      steps,
    );
    const anyGlobal = globalThis as unknown as Record<string, unknown>;
    const saved = anyGlobal["webkit"];
    const posted: Array<{ method: string; args: Record<string, unknown> }> = [];
    anyGlobal["webkit"] = {
      messageHandlers: { modelbot: { postMessage: (m: never) => void posted.push(m) } },
    };
    try {
      const open = t.root.querySelector(".artifacts .file button")!;
      assert.equal(open.textContent, "Open");
      open.click();
      assert.equal(posted[0]!.method, "revealFile");
      assert.match(String(posted[0]!.args["url"]), /inline=1/);
      assert.equal(
        posted[0]!.args["resultsDir"],
        "/Users/me/ModelBot/computers/cmp_1/workspace/out",
      );
    } finally {
      anyGlobal["webkit"] = saved;
      t.restore();
    }
  });
});
