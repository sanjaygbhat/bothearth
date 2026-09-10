import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { uiReferencedAssets } from "../../../src/ui/static.ts";

const UI = join(dirname(fileURLToPath(import.meta.url)), "../../../src/ui");

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const read = (name: string): string => stripComments(readFileSync(join(UI, name), "utf8"));

const sheets = readdirSync(UI)
  .filter((name) => name.endsWith(".css"))
  .sort();

const tokens = read("tokens.css");

function declaredIn(css: string): Set<string> {
  const names = new Set<string>();
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:/g)) names.add(match[1] as string);
  return names;
}

/** Body of the first `<selector> {` block whose header matches. */
function block(css: string, header: RegExp): string {
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

describe("design tokens", () => {
  it("ships every UI sheet in the documented load order", () => {
    // Three foundation sheets, then one view sheet per area. Every one of them
    // is held to every rule below just the same.
    for (const required of ["base.css", "shell.css", "tokens.css", "home.css", "task.css", "settings.css"]) {
      assert.ok(sheets.includes(required), `${required} is missing from src/ui`);
    }
    assert.ok(!sheets.includes("styles.css"), "styles.css was retired; do not bring it back");
    const html = readFileSync(join(UI, "index.html"), "utf8");
    const order = ["/tokens.css", "/base.css", "/shell.css", "/home.css"].map((href) =>
      html.indexOf(href),
    );
    assert.ok(
      order.every((at, i) => at >= 0 && (i === 0 || at > (order[i - 1] as number))),
      "index.html must load tokens -> base -> shell -> view sheets",
    );
    // Every sheet index.html links must be one the packaging smoke test knows
    // about, or a missing sheet ships silently.
    const linked = [...html.matchAll(/href="(\/[a-z-]+\.css)"/g)].map((m) => m[1] as string);
    for (const href of linked) {
      assert.ok(
        uiReferencedAssets().includes(href),
        `${href} is linked from index.html but missing from uiReferencedAssets()`,
      );
    }
  });

  it("resolves every custom property a sheet uses", () => {
    const defined = declaredIn(tokens);
    for (const sheet of sheets) {
      const css = read(sheet);
      const local = declaredIn(css);
      for (const match of css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*([,)])/g)) {
        const name = match[1] as string;
        // `var(--x, fallback)` is allowed to be caller-supplied (e.g. --i).
        if (match[2] === ",") continue;
        assert.ok(
          defined.has(name) || local.has(name),
          `${sheet} uses ${name}, which nothing defines`,
        );
      }
    }
  });

  it("contains task card layers below the shell's Settings and command overlays", () => {
    const view = block(read("shell.css"), /^\.shell-view\s*\{/m);
    assert.match(view, /isolation:\s*isolate/, "a takeover card must not escape above the modal scrim");
    const settings = read("settings.css");
    assert.match(block(settings, /^\.set-scrim\s*\{/m), /z-index:\s*var\(--z-backdrop\)/);
    assert.match(block(settings, /^\.set-sheet\s*\{/m), /z-index:\s*var\(--z-modal\)/);
  });

  it("declares every colour with a resolvable colour value", () => {
    const light = block(tokens, /^:root \{/m);
    let checked = 0;
    for (const match of light.matchAll(/(--color-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      const [, name, value] = match as unknown as [string, string, string];
      assert.match(
        value.trim(),
        /^(oklch\(|color-mix\(|var\(--)/,
        `${name} is not a resolvable colour: ${value.trim()}`,
      );
      checked += 1;
    }
    assert.ok(checked >= 20, `expected the full palette, found ${checked}`);
  });

  it("defines the dark theme in both directions, not just the media query", () => {
    const light = declaredIn(block(tokens, /^:root \{/m));
    const media = block(tokens, /:root:not\(\[data-theme="light"\]\) \{/);
    const explicit = block(tokens, /:root\[data-theme="dark"\] \{/);
    const colours = [...light].filter((name) => name.startsWith("--color-"));
    assert.ok(colours.length >= 20);
    for (const name of colours) {
      assert.ok(media.includes(`${name}:`), `${name} missing from the dark media query`);
      assert.ok(explicit.includes(`${name}:`), `${name} missing from [data-theme="dark"]`);
    }
  });

  it("hard-codes no colour outside tokens.css", () => {
    for (const sheet of sheets.filter((name) => name !== "tokens.css")) {
      const css = read(sheet);
      const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      assert.deepEqual(hex, [], `${sheet} hard-codes ${hex.join(", ")}`);
      const fn = css.match(/\b(rgba?|hsla?)\(/g) ?? [];
      assert.deepEqual(fn, [], `${sheet} hard-codes ${fn.join(", ")}`);
    }
  });

  it("declares no viewport-height cap that could clip an action row", () => {
    // The frame is the only element allowed to own the window height. A panel
    // sized in vh/dvh inside it re-introduces the approval bug: a scroller that
    // is shorter than its own content and pushes the buttons off screen.
    for (const sheet of sheets) {
      const css = read(sheet);
      for (const match of css.matchAll(/max-(height|block-size)\s*:\s*[^;]*\b\d+(d?v(h|min|max))/g)) {
        assert.fail(`${sheet} caps a panel with ${match[0]}`);
      }
      for (const match of css.matchAll(/\b(height|block-size)\s*:\s*100d?vh/g)) {
        assert.ok(
          sheet === "shell.css" && css.slice(0, match.index).lastIndexOf(".win {") >
            css.slice(0, match.index).lastIndexOf("}"),
          `${sheet} sizes something other than the window frame with ${match[0]}`,
        );
      }
    }
  });

  it("never removes a focus indicator without replacing it", () => {
    for (const sheet of sheets) {
      const css = read(sheet);
      for (const match of css.matchAll(/outline\s*:\s*none/g)) {
        // Only legal inside a rule that hands the ring to an ancestor.
        const rule = css.slice(css.lastIndexOf("{", match.index), match.index);
        assert.ok(
          css.slice(0, match.index).includes("focus-well"),
          `${sheet} removes the focus ring: ${rule.trim().slice(0, 60)}`,
        );
      }
      assert.deepEqual(
        css.match(/opacity\s*:\s*0?\.4\d/g) ?? [],
        [],
        `${sheet} fakes a disabled state with opacity instead of a token pair`,
      );
    }
  });

  it("bundles the display face locally, with swap", () => {
    const base = read("base.css");
    assert.match(base, /@font-face/);
    assert.match(base, /font-display:\s*swap/);
    assert.deepEqual(
      base.match(/url\("https?:[^"]*"\)/g) ?? [],
      [],
      "the CSP forbids external font origins",
    );
    for (const file of ["fraunces-latin-wght.woff2", "fraunces-latin-ext-wght.woff2"]) {
      assert.ok(base.includes(`/fonts/${file}`), `base.css must reference ${file}`);
      assert.ok(readFileSync(join(UI, "fonts", file)).subarray(0, 4).toString() === "wOF2");
    }
  });
});
