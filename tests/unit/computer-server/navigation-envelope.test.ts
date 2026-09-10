import assert from "node:assert/strict";
import { test } from "node:test";
import { createState, dispatch } from "../../../computer-server/src/dispatch.ts";

for (const method of ["policy.call", "takeover.grant", "shell_exec"]) {
  test(`navigation envelope refuses internal or non-browser method ${method}`, async () => {
    const state = createState("browser");
    const result = await dispatch(state, { jsonrpc: "2.0", id: 1, method: "policy.call", params: {
      method, params: {}, navigation_origins: ["https://example.com"],
    } });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, "E_POLICY");
    assert.equal(state.browser, null, "invalid envelope must not launch a browser");
  });
}

test("navigation policy rejects an invalid public-browsing flag before starting a browser", async () => {
  const state = createState("browser");
  const result = await dispatch(state, { jsonrpc: "2.0", id: 1, method: "policy.call", params: {
    method: "browser_navigate", params: { url: "https://example.com" }, navigation_origins: [], allow_public_navigation: "true",
  } });
  assert.equal(result.ok, false);
  assert.equal(state.browser, null);
});
