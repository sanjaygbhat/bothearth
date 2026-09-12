import assert from "node:assert/strict";
import { test } from "node:test";
import { createState, dispatch } from "../../../computer-server/src/dispatch.ts";

test("request_takeover returns with field null when page.evaluate hangs", async () => {
  const state = createState("browser");
  let rejectMask: (err: Error) => void = () => {};
  state.browser = {
    maskSecrets: () =>
      new Promise((_resolve, reject) => {
        rejectMask = reject;
      }),
  } as never;
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const started = Date.now();
    const result = await dispatch(state, {
      jsonrpc: "2.0",
      id: 1,
      method: "request_takeover",
      params: { reason: "sign_in", takeover_id: "tk_daemonlease" },
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2_500, `request_takeover took ${elapsed}ms on a hung page`);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal((result.data as { field: unknown }).field, null);
    assert.equal((result.data as { takeover_id: string }).takeover_id, "tk_daemonlease");
    assert.equal(state.takeover.state, "takeover_requested");
    assert.equal(state.takeover.takeoverId, "tk_daemonlease");
    rejectMask(new Error("evaluate timed out"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(rejections.length, 0, `unhandled rejection after hung evaluate: ${rejections}`);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
