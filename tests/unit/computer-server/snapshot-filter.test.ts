import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SNAPSHOT_CONTROL_CAP,
  filterInteractiveYaml,
  resolveSnapRef,
} from "../../../computer-server/src/browser/session.ts";

function fixtureYaml(nButtons: number): string {
  const lines = [
    "- document [ref=e1]:",
    "  - navigation:",
    "    - region:",
    "      - heading \"Catalog\" [level=1]",
    "      - main:",
  ];
  for (let i = 0; i < nButtons; i++) {
    lines.push(`        - button "B${i}" [ref=e${i + 10}]`);
  }
  return lines.join("\n");
}

const LANDMARK_LINE = /^\s*-\s*(document|region|main|navigation)\b/m;

describe("filterInteractiveYaml", () => {
  it("keeps heading, drops unreffed landmark wrappers, caps at 200", () => {
    const raw = fixtureYaml(250);
    const { yaml, omittedNodes } = filterInteractiveYaml(raw);
    assert.match(yaml, /^\s*-\s*heading\b/m);
    assert.match(yaml, /document \[ref=e1\]/);
    assert.match(yaml, /button "B0"/);
    assert.match(yaml, /button "B198"/);
    assert.equal(/\bnavigation\b/.test(yaml), false);
    assert.equal(/\bregion\b/.test(yaml), false);
    assert.equal(yaml.includes("button \"B199\""), false);
    assert.equal(omittedNodes, 51);
    const refs = [...yaml.matchAll(/\[ref=(e\d+)\]/g)].map((m) => m[1]);
    assert.equal(refs.length, SNAPSHOT_CONTROL_CAP);
    assert.equal(omittedNodes > 0, true);
  });

  it("keeps heading-only pages (hybrid ladder)", () => {
    const raw = [
      "- document:",
      "  - heading \"Empty shop\" [level=1]",
      "  - region:",
      "    - navigation:",
    ].join("\n");
    const { yaml, omittedNodes } = filterInteractiveYaml(raw);
    assert.match(yaml, /heading "Empty shop"/);
    assert.equal(LANDMARK_LINE.test(yaml), false);
    assert.equal(omittedNodes, 0);
  });

  it("keeps landmark lines that carry [ref=eN]", () => {
    const raw = [
      "- document:",
      "  - main [ref=e7]:",
      "    - button \"Go\" [ref=e8]",
    ].join("\n");
    const { yaml, omittedNodes } = filterInteractiveYaml(raw);
    assert.match(yaml, /main \[ref=e7\]/);
    assert.match(yaml, /button "Go"/);
    assert.equal(omittedNodes, 0);
  });
});

type FakeLocator = {
  count(): Promise<number>;
  click(): Promise<void>;
};

function fakeLocator(count: number, actionMs = 10_000): FakeLocator {
  return {
    async count() {
      return count;
    },
    async click() {
      await new Promise((r) => setTimeout(r, actionMs));
    },
  };
}

describe("resolveSnapRef", () => {
  it("unknown snapshot returns E_STALE_REF without probing count", async () => {
    let counted = 0;
    const loc = fakeLocator(0);
    const orig = loc.count.bind(loc);
    loc.count = async () => {
      counted += 1;
      return orig();
    };
    const page = {
      locator: () => loc,
      getByRole: () => ({ nth: () => loc }),
    };
    const r = await resolveSnapRef(new Map(), page, "snap_missing", "e1");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "E_STALE_REF");
    assert.equal(counted, 0);
  });

  it("unknown ref (not in refs or bindings) returns E_STALE_REF without probing count", async () => {
    let counted = 0;
    const loc = fakeLocator(0);
    loc.count = async () => {
      counted += 1;
      return 0;
    };
    const snaps = new Map([
      [
        "snap_1",
        {
          refs: new Set(["e1"]),
          bindings: new Map([["e1", { role: "button", name: "Go", nth: 0 }]]),
        },
      ],
    ]);
    const page = {
      locator: () => loc,
      getByRole: () => ({ nth: () => loc }),
    };
    const r = await resolveSnapRef(snaps, page, "snap_1", "e999");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "E_STALE_REF");
    assert.equal(counted, 0);
  });

  it("aria-ref hit does not call count()", async () => {
    let counted = 0;
    const loc = fakeLocator(0);
    loc.count = async () => {
      counted += 1;
      return 0;
    };
    const snaps = new Map([
      ["snap_1", { refs: new Set(["e1"]), bindings: new Map() }],
    ]);
    const page = {
      locator: () => loc,
      getByRole: () => ({ nth: () => loc }),
    };
    const r = await resolveSnapRef(snaps, page, "snap_1", "e1");
    assert.equal(r.ok, true);
    assert.equal(counted, 0);
  });

  it("bindings fallback count()===0 returns E_STALE_REF in <500ms (no 10s action wait)", async () => {
    const loc = fakeLocator(0, 10_000);
    let clicked = false;
    const origClick = loc.click.bind(loc);
    loc.click = async () => {
      clicked = true;
      return origClick();
    };
    const snaps = new Map([
      [
        "snap_1",
        {
          refs: new Set<string>(),
          bindings: new Map([["e5", { role: "button", name: "Go", nth: 0 }]]),
        },
      ],
    ]);
    const page = {
      locator: () => {
        throw new Error("aria-ref path must not run on bindings fallback");
      },
      getByRole: () => ({ nth: () => loc }),
    };
    const t0 = Date.now();
    const r = await resolveSnapRef(snaps, page, "snap_1", "e5");
    const elapsed = Date.now() - t0;
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "E_STALE_REF");
    assert.equal(clicked, false);
    assert.ok(elapsed < 500, `elapsed ${elapsed}ms`);
  });
});
