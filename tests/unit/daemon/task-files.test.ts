import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startDaemon, type DaemonHandle } from "../../../src/daemon/server.ts";
import { bootstrapSession } from "../../helpers/daemon.ts";

/**
 * A receipt names a task and a file, never a computer, so `GET
 * /api/v1/tasks/:id/files` is the route anything reading the API the way the
 * receipt reads will ask for. It answered 404 for a finished task whose own
 * receipt listed the file.
 */

process.env.MODELBOT_TEST_FAKE_COMPUTER = "1";

let daemon: DaemonHandle;
let headers: Record<string, string>;
let taskId: string;
let outputDir: string;
let workspaceRoot: string;

before(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), "mb-task-files-"));
  daemon = await startDaemon({ port: 0, mcpToken: "files-mcp", bootstrapToken: "files-boot", workspaceRoot });
  ({ headers } = await bootstrapSession(daemon, "files-boot"));
  daemon.store.insertComputer({ id: "c1", name: "c1", capabilities: ["browser"], persistent: false, status: "running" });
  taskId = daemon.store.insertTask({ computer_id: "c1", goal: "save a file", max_steps: 5 }).id;
  outputDir = join(workspaceRoot, "c1", "out");
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(workspaceRoot, "c1", "out", "report.md"), "# saved\n");
});

after(async () => { await daemon.close(); });

const get = (path: string, init?: RequestInit) =>
  fetch(`${daemon.baseUrl}${path}`, { headers, ...init });

function listedZip(buf: Uint8Array): Map<string, Buffer> {
  const data = Buffer.from(buf);
  const out = new Map<string, Buffer>();
  let i = 0;
  while (i + 30 <= data.length && data.readUInt32LE(i) === 0x04034b50) {
    const nameLen = data.readUInt16LE(i + 26);
    const extraLen = data.readUInt16LE(i + 28);
    const size = data.readUInt32LE(i + 18);
    const nameStart = i + 30;
    const name = data.subarray(nameStart, nameStart + nameLen).toString("utf8");
    const dataStart = nameStart + nameLen + extraLen;
    out.set(name, Buffer.from(data.subarray(dataStart, dataStart + size)));
    i = dataStart + size;
  }
  return out;
}

test("the task route serves the file its own receipt names", async () => {
  const res = await get(`/api/v1/tasks/${taskId}/files?path=out/report.md`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "# saved\n");
  assert.match(res.headers.get("content-disposition") ?? "", /filename="report\.md"/);
});

test("an older receipt's bare filename still resolves through the results directory", async () => {
  const res = await get(`/api/v1/tasks/${taskId}/files?path=report.md`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "# saved\n");
});

test("HEAD answers whether the file is still there", async () => {
  assert.equal((await get(`/api/v1/tasks/${taskId}/files?path=out/report.md`, { method: "HEAD" })).status, 200);
  assert.equal((await get(`/api/v1/tasks/${taskId}/files?path=out/gone.md`, { method: "HEAD" })).status, 404);
});

test("large and empty files download, and aborting a download leaves the daemon usable", async () => {
  const data = Buffer.alloc(8 * 1024 * 1024, 0x61);
  writeFileSync(join(outputDir, "large.bin"), data);
  writeFileSync(join(outputDir, "empty.bin"), "");
  const path = `/api/v1/tasks/${taskId}/files?path=out/large.bin`;
  const res = await get(path);
  assert.equal(res.headers.get("content-length"), String(data.length));
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), data);
  const controller = new AbortController();
  const aborted = await get(path, { signal: controller.signal });
  assert.equal(aborted.status, 200);
  controller.abort();
  const empty = await get(`/api/v1/tasks/${taskId}/files?path=out/empty.bin`);
  assert.equal(empty.status, 200);
  assert.equal(await empty.text(), "");
  assert.equal((await get(path, { method: "HEAD" })).status, 200);
});

test("the jail and the session are the computer route's, not a second set", async () => {
  assert.equal((await get(`/api/v1/tasks/${taskId}/files?path=../../etc/passwd`)).status, 403);
  assert.equal((await get(`/api/v1/tasks/${taskId}/files?path=/etc/passwd`)).status, 403);
  assert.equal((await get(`/api/v1/tasks/${taskId}/files`)).status, 400);
  assert.equal((await get("/api/v1/tasks/task_missing/files?path=out/report.md")).status, 404);
  const res = await fetch(`${daemon.baseUrl}/api/v1/tasks/${taskId}/files?path=out/report.md`);
  assert.equal(res.status, 401);
});

test("a symlink that leaves the workspace is refused", async () => {
  symlinkSync("/etc/passwd", join(workspaceRoot, "c1", "escape"));
  const res = await get(`/api/v1/tasks/${taskId}/files?path=escape`);
  assert.ok(res.status === 403 || res.status === 404, `symlink status=${res.status}`);
  assert.notEqual(res.status, 200);
  assert.equal((await res.text()).includes("root:"), false);
});

test("Open can ask the browser to render; Download stays an attachment", async () => {
  const inline = await get(`/api/v1/tasks/${taskId}/files?path=out/report.md&inline=1`);
  assert.equal(inline.status, 200);
  assert.match(inline.headers.get("content-disposition") ?? "", /^inline;/);
  assert.match(inline.headers.get("content-type") ?? "", /text\/plain/);
  const download = await get(`/api/v1/tasks/${taskId}/files?path=out/report.md`);
  assert.match(download.headers.get("content-disposition") ?? "", /^attachment;/);
});

test("the zip holds exactly the files this task listed, not everything on disk", async () => {
  writeFileSync(join(outputDir, "kept.md"), "kept\n");
  writeFileSync(join(outputDir, "extra.md"), "extra\n");
  daemon.store.appendAuditRef({
    type: "download.promoted",
    task_id: taskId,
    computer_id: "c1",
    body: { path: "out/kept.md" },
    hash: "zip-kept",
  });
  daemon.store.appendAuditRef({
    type: "download.promoted",
    task_id: taskId,
    computer_id: "c1",
    body: { path: "../../etc/passwd" },
    hash: "zip-escape",
  });
  const res = await get(`/api/v1/tasks/${taskId}/files.zip`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename=".*files\.zip"/);
  const files = listedZip(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual([...files.keys()], ["out/kept.md"]);
  assert.equal(files.get("out/kept.md")!.toString(), "kept\n");
  assert.equal(files.has("out/extra.md"), false);
  assert.equal(files.has("out/report.md"), false);
  const anon = await fetch(`${daemon.baseUrl}/api/v1/tasks/${taskId}/files.zip`);
  assert.equal(anon.status, 401);
});

test("this computer's workspace path is on the task", async () => {
  const local = await get(`/api/v1/tasks/${taskId}`);
  assert.equal(local.status, 200);
  const body = await local.json() as { task: { workspace_dir?: string } };
  assert.equal(body.task.workspace_dir, join(workspaceRoot, "c1"));
});
