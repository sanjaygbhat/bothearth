import { test } from "node:test";
import assert from "node:assert/strict";
import { apiFetch, apiPost, ApiError } from "../../../src/ui/api.ts";

test("API errors keep a useful server message and structured details", async () => {
  const old = globalThis.fetch;
  const body = { error: "E_TASK_ACTIVE", message: "Open your current task before starting another.", task_id: "current" };
  globalThis.fetch = async () => Response.json(body, { status: 409 });
  try {
    await assert.rejects(apiPost("/api/v1/tasks", { goal: "A new task" }), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message, body.message);
      assert.equal(error.status, 409);
      assert.deepEqual(error.body, body);
      return true;
    });
  } finally { globalThis.fetch = old; }
});

test("an empty reply is an answer, not a parse fault", async () => {
  const old = globalThis.fetch;
  // Exactly what the daemon sends for a HEAD: the status, the content type,
  // and no body at all.
  globalThis.fetch = (async () =>
    new Response(null, {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    })) as typeof fetch;
  try {
    await assert.rejects(
      () => apiFetch("/api/v1/computers/c/files?path=gone.md", { method: "HEAD" }),
      (error: unknown) => error instanceof ApiError && error.status === 404,
    );
  } finally { globalThis.fetch = old; }
});
