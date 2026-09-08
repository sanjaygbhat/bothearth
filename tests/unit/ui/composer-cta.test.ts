/**
 * Where the ember goes: on the button that acts, never on the box you type in.
 * The CSS assertions parse the shipped sheets, so a renamed token fails here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { composerState } from "../../../src/ui/home.ts";

const UI = join(dirname(fileURLToPath(import.meta.url)), "../../../src/ui");
const sheet = (name: string) => readFileSync(join(UI, name), "utf8");

describe("the ember is on the button, not on the box", () => {
  it("never gives the composer a full focus ring", () => {
    const base = sheet("base.css");
    const rule = base.slice(
      base.indexOf(".focus-well:has(textarea:focus-visible)"),
      base.indexOf(".focus-well textarea:focus-visible"),
    );
    assert.ok(rule.length > 0, "the focus-well rule still exists");
    assert.doesNotMatch(
      rule,
      /outline:\s*var\(--focus-width\)/,
      "a 2px ember ring round a 160px box is the loudest thing on the screen",
    );
    // Removed, but replaced — a well with no indicator would be WCAG 2.4.7.
    assert.match(rule, /border-color:\s*var\(--color-accent\)/);
    assert.match(rule, /box-shadow:/);
  });

  it("keeps a waiting primary filled in ink, never in disabled grey", () => {
    const base = sheet("base.css");
    const start = base.indexOf('.btn.primary[aria-disabled="true"]');
    assert.ok(start > 0, "the waiting-primary rule exists");
    const rule = base.slice(start, base.indexOf("}", start));
    assert.match(rule, /background:\s*var\(--color-ink-fill\)/);
    assert.match(rule, /color:\s*var\(--color-on-ink\)/);
    assert.doesNotMatch(rule, /--color-muted|--color-surface/);
    // And the pair exists in every theme block, or dark would fall back to light.
    const tokens = sheet("tokens.css");
    assert.equal((tokens.match(/--color-ink-fill:/g) ?? []).length, 3);
    assert.equal((tokens.match(/--color-on-ink:/g) ?? []).length, 3);
  });

  it("makes the primary 44px at every width", () => {
    const base = sheet("base.css");
    const start = base.indexOf(".btn.primary {");
    const rule = base.slice(start, base.indexOf("}", start));
    assert.match(rule, /height:\s*var\(--control-h-touch\)/);
  });

  it("keeps the start button a primary in every composer state", () => {
    for (const input of [
      { ready: true, blockerKey: null, hasText: true },
      { ready: true, blockerKey: null, hasText: false },
      { ready: false, blockerKey: "docker_missing", hasText: true },
      { ready: false, blockerKey: "ai_not_connected", hasText: false },
    ]) {
      const state = composerState({ ...input, armed: false, submitting: false });
      assert.equal(state.primary, true, `${input.blockerKey ?? "ready"} keeps the primary treatment`);
    }
    // Only text in the box lights the ember; everything else is the ink fill.
    assert.equal(
      composerState({ ready: true, blockerKey: null, hasText: true, armed: false, submitting: false })
        .disabled,
      false,
    );
    assert.equal(
      composerState({ ready: true, blockerKey: null, hasText: false, armed: false, submitting: false })
        .disabled,
      true,
    );
  });

  it("runs one leading in both themes, so nothing drifts by mid-page", () => {
    // Light and dark running different body leading is where a mid-page drift
    // accumulates, so neither dark block may set leading at all.
    const tokens = sheet("tokens.css");
    for (const marker of ['@media (prefers-color-scheme: dark)', ':root[data-theme="dark"]']) {
      let from = 0;
      for (;;) {
        const at = tokens.indexOf(marker, from);
        if (at < 0) break;
        from = at + marker.length;
        const block = tokens.slice(at, tokens.indexOf("\n}", at));
        assert.doesNotMatch(block, /--leading-/, `${marker} must not redefine leading`);
      }
    }
  });
});
