import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHybridDriver } from "../../../src/drivers/hybrid.ts";
import type { ToolResult } from "../../../src/types/contracts.ts";

describe("hybrid driver ladder", () => {
  it("first stale ref re-snapshots at A11Y_FULL; second scopes", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const transport = {
      async call(method: string, params?: unknown): Promise<ToolResult> {
        calls.push({ method, params });
        return {
          ok: true,
          data: {
            snapshot_id: "snap_new",
            yaml: '- button "Continue" [ref=e1]',
            refs: ["e1"],
            url: "https://fixture.local/",
            title: "Fixture",
          },
        };
      },
    };
    const driver = createHybridDriver(transport);
    await driver.observe("c1");
    const stale: ToolResult = {
      ok: false,
      error: { code: "E_STALE_REF", message: "stale ref" },
    };
    const notice = {
      name: "browser_click",
      arguments: { snapshot_id: "snap_old", ref: "e1" },
      result: stale,
    };
    driver.recordToolResult("c1", notice);
    assert.equal(driver.getRung("c1"), "A11Y_FULL");
    await driver.observe("c1");
    assert.equal((calls.at(-1)?.params as { scope?: unknown }).scope, null);

    driver.recordToolResult("c1", notice);
    assert.equal(driver.getRung("c1"), "A11Y_SCOPED");
    await driver.observe("c1");
    assert.equal((calls.at(-1)?.params as { scope?: unknown }).scope, "e1");
  });

  it("empty snapshots and canvas-only regions escalate to vision", async () => {
    const driver = createHybridDriver({
      async call(): Promise<ToolResult> {
        return {
          ok: true,
          data: { snapshot_id: "s", yaml: "- canvas", refs: [], url: "x", title: "x" },
        };
      },
    });
    const observed = await driver.observe("c2");
    assert.equal(observed.rung, "VISION_COORDS");
  });
});
