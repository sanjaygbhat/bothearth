import { test } from "node:test";
import assert from "node:assert/strict";
import { apiFetch, apiPost, ApiError, getCsrfToken, setCsrfToken } from "../../../src/ui/api.ts";

test("a stale tab refreshes its session token and retries only a rejected CSRF mutation", async () => {
  const old = globalThis.fetch;
  const prior = getCsrfToken();
  const calls: Array<{ path: string; csrf: string | null; body: BodyInit | null | undefined }> = [];
  setCsrfToken("old-session-token");
  globalThis.fetch = async (input, init) => {
    calls.push({ path: String(input), csrf: new Headers(init?.headers).get("X-CSRF-Token"), body: init?.body });
    assert.equal(init?.credentials, "same-origin");
    if (calls.length === 1) return Response.json({ error: "E_AUTH", message: "missing or invalid CSRF" }, { status: 403 });
    if (String(input) === "/api/v1/session") return Response.json({ ok: true, csrf: "current-session-token" });
    return Response.json({ status: "signing_in" });
  };
  try {
    assert.deepEqual(await apiPost("/api/v1/connection/sign-in", { provider: "codex" }), { status: "signing_in" });
    assert.deepEqual(calls.map(c => c.path), ["/api/v1/connection/sign-in", "/api/v1/session", "/api/v1/connection/sign-in"]);
    assert.equal(calls[0]?.csrf, "old-session-token");
    assert.equal(calls[2]?.csrf, "current-session-token");
    assert.equal(calls[2]?.body, calls[0]?.body);
    assert.equal(getCsrfToken(), "current-session-token");
  } finally { globalThis.fetch = old; setCsrfToken(prior); }
});

test("session recovery leaves unrelated denials alone and stops after one CSRF retry", async () => {
  const old = globalThis.fetch;
  const prior = getCsrfToken();
  try {
    for (const [status, body, expectedCalls] of [
      [403, { error: "E_AUTH", message: "missing or invalid CSRF" }, 3],
      [403, { error: "E_POLICY", message: "This action is not allowed." }, 1],
      [401, { error: "E_AUTH", message: "invalid session" }, 1],
      [500, { error: "E_IO", message: "The connection was lost." }, 1],
    ] as const) {
      let calls = 0;
      globalThis.fetch = async (input) => {
        calls++;
        return String(input) === "/api/v1/session" ? Response.json({ ok: true, csrf: "fresh-token" }) : Response.json(body, { status });
      };
      await assert.rejects(apiPost("/api/v1/tasks", { goal: "A new task" }), (error: unknown) => error instanceof ApiError && error.status === status);
      assert.equal(calls, expectedCalls);
    }
  } finally { globalThis.fetch = old; setCsrfToken(prior); }
});

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
