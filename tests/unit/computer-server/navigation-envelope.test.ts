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
