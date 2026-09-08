/**
 * The approval's action row must always be on screen and clickable, at every
 * width. Three separate things have pushed it off before: actions inside the
 * scrolling body, nested scrollers in the 620-1100 stack, and a phone
 * breakpoint that kept the 520px live track.
 *
 * A unit test cannot lay a page out, so this asserts the structural invariants
 * that make the browser result reproducible instead.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const UI = join(dirname(fileURLToPath(import.meta.url)), "../../../src/ui");
const css = readFileSync(join(UI, "task.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Body of the first `<selector> {` block whose header matches. */
function block(header: RegExp): string {
  const start = css.search(header);
  assert.ok(start >= 0, `block not found: ${header}`);
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated block: ${header}`);
}

/** Everything between `@media <query> {` and its matching brace. */
function media(query: RegExp): string {
  return block(new RegExp(`@media\\s+${query.source}\\s*\\{`));
}

describe("approval action row stays reachable", () => {
  it("keeps the actions out of the scrolling body and unable to shrink", () => {
    const actions = block(/^\.approval-actions\s*\{/m);
    assert.match(actions, /flex:\s*0 0 auto/, "the action row must never shrink away");

    const body = block(/^\.approval-body\s*\{/m);
    assert.match(body, /overflow:\s*auto/, "the body is the scroller, so the actions need not be");
    assert.match(body, /min-height:\s*0/, "without this the body refuses to shrink and pushes the actions down");
    assert.match(body, /flex:\s*1 1 auto/);

    const card = block(/^\.approval\s*\{/m);
    assert.match(card, /flex:\s*0 1 auto/, "the card yields to the column instead of overflowing it");
    assert.match(card, /min-height:\s*0/);
  });

  it("gives the stacked breakpoints one scroller and one column", () => {
    // 620-1100: a single page scroller. Two nested ones let the live view
    // paint over the card.
    const mid = media(/\(min-width:\s*621px\)\s+and\s+\(max-width:\s*1100px\)/);
    assert.match(mid, /\.task-grid\s*\{[^}]*overflow-y:\s*auto/, "the stack scrolls as one page");
    assert.match(mid, /\.approval-body\s*\{[^}]*max-height:\s*\d+px/, "the card is capped so its actions stay on screen");

    // <=620: one column. Without this the live track survives while hidden.
    const phone = media(/\(max-width:\s*620px\)/);
    assert.match(
      phone,
      /\.task-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
      "the phone layout must drop the live-view track, not just hide the panel",
    );
    assert.match(phone, /\.feed\s*\{[^}]*flex:\s*1 1 auto/, "the feed yields to the card, not the other way round");
    assert.match(phone, /\.feed\s*\{[^}]*min-height:\s*0/);
  });

  it("lets the column scroll rather than swallow what does not fit", () => {
    // `auto` still clips, so nothing paints on top of the live view at 900x600
    // — but `hidden` made an overflow silent, and a 3,348-character goal put
    // the approval buttons 1,021px below a column with no scrollbar.
    assert.match(block(/^\.task-left\s*\{/m), /overflow:\s*auto/);
  });

  it("puts the card above the masked feed so its buttons take the click", () => {
    // `.feed` carries a mask, which makes it a stacking context; an
    // un-positioned `.approval` before it in the DOM painted underneath, and
    // `elementFromPoint` on all three buttons returned `DIV.feed`.
    const card = block(/^\.approval\s*\{/m);
    assert.match(card, /position:\s*relative/);
    assert.match(card, /z-index:\s*var\(--z-raised\)/);
  });

  it("clamps the goal and gives the rest its own scroller", () => {
    // The one thing above the card in the column. Unclamped it pushed the card,
    // the disclosure and Take control off the bottom of the view.
    const full = block(/^\.goal-full\s*\{/m);
    assert.match(full, /overflow:\s*auto/, "the full prompt scrolls inside itself");
    assert.match(full, /min-height:\s*0/, "without this it refuses to shrink");
    assert.match(full, /flex:\s*0 1 auto/, "it yields to the column, the card does not");
  });

  it("shows one countdown, and it is not the card's", () => {
    assert.equal(css.includes(".timer"), false, "the card's own timer disagreed with the banner");
  });
});

describe("the action row", () => {
  it("matches every target in the row to 44px", () => {
    const start = css.indexOf(".approval-actions .btnrow .btn");
    assert.ok(start > 0, "the row sizes its own buttons");
    assert.match(css.slice(start, css.indexOf("}", start)), /height:\s*var\(--control-h-touch\)/);
  });
});
