import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_ENABLED_ROUTINES,
  RoutinesStore,
  TOO_MANY_ENABLED,
} from "../../../src/scheduler/store.ts";

describe("routines store", () => {
  it("caps at 20 enabled; */5 still creates", () => {
    const store = new RoutinesStore(":memory:");
    const task = { goal: "g", capabilities: ["browser"] as const };
    for (let i = 0; i < MAX_ENABLED_ROUTINES; i++) {
      store.create({
        name: `r${i}`,
        cron: "*/5 * * * *",
        computer_name: "c",
        task,
      });
    }
    assert.equal(store.countEnabled(), 20);
    assert.throws(
      () =>
        store.create({
          name: "r21",
          cron: "*/5 * * * *",
          computer_name: "c",
          task,
        }),
      (err: unknown) =>
        err instanceof Error && err.message === TOO_MANY_ENABLED,
    );
    const disabled = store.create({
      name: "off",
      cron: "*/5 * * * *",
      computer_name: "c",
      task,
      enabled: false,
    });
    assert.equal(disabled.enabled, 0);
    store.close();
  });

});
