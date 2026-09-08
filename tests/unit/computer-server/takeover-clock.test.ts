/**
 * The takeover clock used to start when the bot asked for help and could never
 * be extended, so a person who was still typing lost control ten minutes after
 * a question they had not yet read.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createTakeoverSession,
  gateMethod,
  transition,
  type TakeoverSession,
} from "../../../computer-server/src/takeover-gate.ts";

const MINUTE = 60_000;

function at<T>(ms: number, fn: () => T): T {
  const real = Date.now;
  Date.now = () => ms;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

function granted(ms: number): TakeoverSession {
  const session = createTakeoverSession();
  at(ms, () => {
    transition(session, "request");
    transition(session, "grant");
  });
  return session;
}

function expired(session: TakeoverSession, ms: number): boolean {
  return Date.parse(session.expiresAt ?? "") <= ms;
}

test("relayed input renews the clock", () => {
  const session = granted(0);
  for (const method of ["live.pointer", "live.key", "live.text"]) {
    assert.equal(at(9 * MINUTE, () => gateMethod(session, method, session.epoch)), null);
    assert.equal(expired(session, 18 * MINUTE), false, `${method} did not renew the lease`);
  }
});

test("silence still expires the clock", () => {
  const session = granted(0);
  assert.equal(expired(session, 9 * MINUTE), false);
  assert.equal(expired(session, 11 * MINUTE), true);
});

test("asking does not start the clock; granting does", () => {
  const session = createTakeoverSession();
  at(0, () => transition(session, "request"));
  assert.equal(session.expiresAt, null, "the bot's question started the human's clock");
  at(30 * MINUTE, () => transition(session, "grant"));
  assert.equal(expired(session, 39 * MINUTE), false);
});

test("input the gate refuses does not renew the clock", () => {
  const session = granted(0);
  assert.notEqual(at(MINUTE, () => gateMethod(session, "live.key", session.epoch + 1)), null);
  assert.equal(expired(session, 11 * MINUTE), true, "a rejected frame extended the lease");
});
