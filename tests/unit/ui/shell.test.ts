import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashSegments, matchRoute, normalizeTheme } from "../../../src/ui/shell.ts";

describe("shell router", () => {
  it("reads a hash path and ignores its query", () => {
    assert.deepEqual(hashSegments("#/"), []);
    assert.deepEqual(hashSegments(""), []);
    assert.deepEqual(hashSegments("#/tasks/t_1"), ["tasks", "t_1"]);
    assert.deepEqual(hashSegments("#/tasks/t_1?view=control"), ["tasks", "t_1"]);
    // A bootstrap link is not a route; it must still land on home.
    assert.deepEqual(hashSegments("#bootstrap=abc"), []);
  });

  it("matches the routes ux-spec §2 defines", () => {
    assert.deepEqual(matchRoute("#/", "#/"), {});
    assert.deepEqual(matchRoute("#/", ""), {});
    assert.deepEqual(matchRoute("#/", "#bootstrap=abc"), {});
    assert.equal(matchRoute("#/", "#/tasks/t_1"), null);

    assert.deepEqual(matchRoute("#/tasks/:id", "#/tasks/t_1"), { id: "t_1" });
    assert.deepEqual(matchRoute("#/tasks/:id", "#/tasks/a%2Fb"), { id: "a/b" });
    assert.equal(matchRoute("#/tasks/:id", "#/tasks"), null);
    assert.equal(matchRoute("#/tasks/:id", "#/tasks/t_1/steps"), null);

    assert.deepEqual(matchRoute("#/settings/:section?", "#/settings"), {});
    assert.deepEqual(matchRoute("#/settings/:section?", "#/settings/devices"), {
      section: "devices",
    });
    assert.equal(matchRoute("#/settings/:section?", "#/computers"), null);
  });

  it("lets the catch-all match anything", () => {
    for (const hash of ["", "#/", "#/tasks/t_1", "#/anything/at/all"]) {
      assert.deepEqual(matchRoute("*", hash), {});
    }
  });
});

describe("shell theme", () => {
  it("accepts only the three documented choices and defaults to system", () => {
    assert.equal(normalizeTheme("dark"), "dark");
    assert.equal(normalizeTheme("light"), "light");
    assert.equal(normalizeTheme("system"), "system");
    for (const junk of [null, undefined, "", "Dark", "sepia", 3]) {
      assert.equal(normalizeTheme(junk), "system");
    }
  });
});
