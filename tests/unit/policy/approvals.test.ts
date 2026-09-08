import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createApproval,
  decideApproval,
  type ApprovalStore,
  type StoredApproval,
} from "../../../src/policy/approvals.ts";
import type { ApprovalRequest } from "../../../src/types/contracts.ts";

/** The daemon keeps pending approvals in its task record; this stands in for it. */
function pendingStore(request: ApprovalRequest): ApprovalStore {
  const map = new Map<string, StoredApproval>([
    [request.approval_id, { request, status: "pending" }],
  ]);
  return { get: (id) => map.get(id), set: (id, v) => { map.set(id, v); } };
}

describe("approval binding + expiry", () => {
  it("creates bind tuple {task_id, control_epoch, origin, action_hash, expires}", () => {
    const now = new Date("2026-09-02T12:00:00.000Z");
    const req = createApproval({
      tool: "browser_click",
      args: { ref: "e1" },
      gate: "payment",
      task_id: "t_1",
      control_epoch: 7,
      origin: "https://shop.example.com",
      now,
      ttl_sec: 120,
    });
    assert.equal(req.bind.task_id, "t_1");
    assert.equal(req.bind.control_epoch, 7);
    assert.equal(req.bind.origin, "https://shop.example.com");
    assert.equal(typeof req.bind.action_hash, "string");
    assert.equal(req.bind.action_hash.length, 64);
    assert.equal(req.bind.expires, "2026-09-02T12:02:00.000Z");
  });

  it("agent cannot approve", () => {
    const req = createApproval({
      tool: "browser_upload",
      args: { paths: ["a"] },
      gate: "upload",
      task_id: "t_1",
      control_epoch: 1,
      origin: "https://app.example.com",
    });
    const store = pendingStore(req);
    const r = decideApproval(store, {
      approval_id: req.approval_id,
      decision: "allow_once",
      actor: "agent",
      task_id: req.bind.task_id,
      control_epoch: req.bind.control_epoch,
      origin: req.bind.origin,
      action_hash: req.bind.action_hash,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /agent/i);
    assert.equal(store.get(req.approval_id)?.status, "pending");
  });

  it("human allow_once with matching bind succeeds", () => {
    const req = createApproval({
      tool: "browser_click",
      args: {},
      gate: "payment",
      task_id: "t_1",
      control_epoch: 2,
      origin: "https://app.example.com",
    });
    const store = pendingStore(req);
    const r = decideApproval(store, {
      approval_id: req.approval_id,
      decision: "allow_once",
      actor: "human",
      task_id: "t_1",
      control_epoch: 2,
      origin: "https://app.example.com",
      action_hash: req.bind.action_hash,
    });
    assert.deepEqual(r, { ok: true, status: "approved" });
  });

  it("binding mismatch rejected", () => {
    const req = createApproval({
      tool: "browser_click",
      args: {},
      gate: "payment",
      task_id: "t_1",
      control_epoch: 2,
      origin: "https://app.example.com",
    });
    const store = pendingStore(req);
    const r = decideApproval(store, {
      approval_id: req.approval_id,
      decision: "allow_once",
      actor: "human",
      task_id: "t_1",
      control_epoch: 99,
      origin: "https://app.example.com",
      action_hash: req.bind.action_hash,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /binding/i);
  });

  it("expired approval cannot be decided", () => {
    const created = new Date("2026-09-02T12:00:00.000Z");
    const req = createApproval({
      tool: "browser_click",
      args: {},
      gate: "delete",
      task_id: "t_1",
      control_epoch: 1,
      origin: "https://app.example.com",
      now: created,
      ttl_sec: 60,
    });
    const store = pendingStore(req);
    const later = new Date("2026-09-02T12:05:00.000Z");
    const r = decideApproval(store, {
      approval_id: req.approval_id,
      decision: "allow_once",
      actor: "human",
      task_id: "t_1",
      control_epoch: 1,
      origin: "https://app.example.com",
      action_hash: req.bind.action_hash,
      now: later,
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.status, "expired");
    }
  });
});
