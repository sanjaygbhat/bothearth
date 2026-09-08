/**
 * The daemon once advertised `write_file` to the model while the computer
 * it was attached to answered `E_CAPABILITY: unknown method: write_file`, and
 * the only evidence was a failed task and a receipt that lied about it. The
 * daemon now asks the computer what it can run, so this list has to be true.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createState, dispatch, SUPPORTED_METHODS } from "../../../computer-server/src/dispatch.ts";
import { gateMethod } from "../../../computer-server/src/takeover-gate.ts";
import { TOOL_NAMES } from "../../../src/types/contracts.ts";

const SOURCE = fileURLToPath(new URL("../../../computer-server/src/dispatch.ts", import.meta.url));

test("the advertised list and the switch cannot drift apart", () => {
  const body = readFileSync(SOURCE, "utf8").split("export async function dispatch(")[1] ?? "";
  const cases = new Set(
    [...body.matchAll(/^\s*case "([^"]+)":/gm)].map((m) => m[1]!),
  );
  assert.ok(cases.size > 30, "the switch was not found");
  for (const method of cases) {
    assert.ok(SUPPORTED_METHODS.includes(method), `switch answers ${method} but does not advertise it`);
  }
  for (const method of SUPPORTED_METHODS) {
    assert.ok(cases.has(method), `advertised ${method} has no case in the switch`);
  }
});

test("every catalogue tool the daemon can offer is advertised", () => {
  for (const tool of TOOL_NAMES) {
    assert.ok(SUPPORTED_METHODS.includes(tool), `${tool} is in TOOL_NAMES but this computer does not answer it`);
  }
});

test("`methods` answers the list, and answers it in either role", async () => {
  for (const role of ["browser", "shell"] as const) {
    const result = await dispatch(createState(role), { jsonrpc: "2.0", id: 1, method: "methods" });
    assert.equal(result.ok, true, `${role} refused the introspection call`);
    const methods = (result as { data: { methods: string[] } }).data.methods;
    assert.ok(methods.includes("write_file"), `${role} did not report write_file`);
    assert.deepEqual(methods, [...SUPPORTED_METHODS]);
  }
});

test("an unknown method is still refused, which is the signal the daemon learns from", async () => {
  const result = await dispatch(createState("browser"), { jsonrpc: "2.0", id: 1, method: "no_such_tool" });
  assert.equal(result.ok, false);
  assert.equal((result as { error: { code: string } }).error.code, "E_CAPABILITY");
});

test("introspection is not refused while a human has control", () => {
  const session = { state: "human", epoch: 3, takeoverId: "t1", expiresAt: null, reason: null } as never;
  assert.equal(gateMethod(session, "methods"), null, "asking what a computer can do is not an action on the page");
  assert.notEqual(gateMethod(session, "write_file"), null, "acting is still blocked mid-takeover");
});
