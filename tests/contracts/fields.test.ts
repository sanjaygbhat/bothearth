import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ERROR_CODES, toolError } from "../../src/protocol/errors.ts";
import {
  fromWireState,
  isTakeoverExemptTool,
  TAKEOVER_EXEMPT_TOOLS,
  toWireState,
} from "../../src/protocol/takeover.ts";
import {
  APPROVAL_TTL_SEC,
  EVENT_TYPES,
  type ApprovalBind,
  type BrowserScreenshotOutput,
  type BrowserSnapshotOutput,
  type CreateTaskBody,
  type FilesDownloadQuery,
  type PolicyPendingDetails,
  type UsageEventBody,
} from "../../src/types/contracts.ts";

describe("contract field freeze", () => {
  it("snapshot_id + screenshot CSS geometry fields exist", () => {
    const snap: BrowserSnapshotOutput = {
      snapshot_id: "snap_1",
      yaml: "Root",
      truncated: false,
      refs: ["e1"],
      url: "https://example.com",
      title: "Example",
    };
    assert.equal(typeof snap.snapshot_id, "string");

    const shot: BrowserScreenshotOutput = {
      image_id: "img_1",
      mime: "image/jpeg",
      width: 1280,
      height: 720,
      css_width: 1280,
      css_height: 720,
      scale: 1,
      scroll_x: 0,
      scroll_y: 40,
    };
    assert.equal(shot.css_width, 1280);
    assert.equal(shot.css_height, 720);
    assert.equal(shot.scale, 1);
    assert.equal(shot.scroll_x, 0);
    assert.equal(shot.scroll_y, 40);
  });

  it("approval bind tuple + E_POLICY_PENDING details", () => {
    const bind: ApprovalBind = {
      task_id: "t1",
      control_epoch: 3,
      origin: "https://pay.example",
      action_hash: "sha256:abc",
      expires: "2026-09-02T12:02:00.000Z",
    };
    assert.deepEqual(Object.keys(bind).sort(), [
      "action_hash",
      "control_epoch",
      "expires",
      "origin",
      "task_id",
    ]);
    assert.equal(APPROVAL_TTL_SEC, 120);

    const pending: PolicyPendingDetails = {
      approval_id: "ap_1",
      bind,
    };
    const err = toolError("E_POLICY_PENDING", undefined, {
      approval_id: pending.approval_id,
      bind: pending.bind,
    });
    assert.equal(err.error.code, "E_POLICY_PENDING");
    assert.equal(
      (err.error.details as PolicyPendingDetails).approval_id,
      "ap_1",
    );
  });

  it("usage event + task driver/capabilities/max_steps + files download", () => {
    assert.ok((EVENT_TYPES as readonly string[]).includes("usage"));
    const usage: UsageEventBody = {
      tokens_in: 10,
      tokens_out: 20,
      usd_est: 0.01,
      steps: 2,
    };
    assert.equal(usage.steps, 2);

    const task: CreateTaskBody = {
      computer_id: "c1",
      goal: "do thing",
      driver: "hybrid",
      capabilities: ["browser"],
      max_steps: 60,
    };
    assert.equal(task.driver, "hybrid");
    assert.equal(task.max_steps, 60);

    const files: FilesDownloadQuery = { path: "/workspace/out.csv" };
    assert.equal(files.path.startsWith("/workspace"), true);
  });

  it("E_TAKEOVER_BUSY present; exempt tools + expired wire synonym", () => {
    assert.ok((ERROR_CODES as readonly string[]).includes("E_TAKEOVER_BUSY"));
    assert.deepEqual([...TAKEOVER_EXEMPT_TOOLS].sort(), [
      "done",
      "takeover_status",
    ]);
    assert.equal(isTakeoverExemptTool("browser_click"), false);
    assert.equal(isTakeoverExemptTool("takeover_status"), true);
    assert.equal(fromWireState("expired"), "paused");
    assert.equal(toWireState("paused"), "paused");
  });
});
