import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

before(async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "mb-task-files-"));
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
  assert.equal((await get(`/api/v1/tasks/${taskId}/files`)).status, 400);
  assert.equal((await get("/api/v1/tasks/task_missing/files?path=out/report.md")).status, 404);
  const res = await fetch(`${daemon.baseUrl}/api/v1/tasks/${taskId}/files?path=out/report.md`);
  assert.equal(res.status, 401);
});
