import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendTextChild } from "../../../src/ui/safe.ts";

type FakeNode = { tagName: string; textContent: string; innerHTML: string; className: string };

describe("tool-derived text in the DOM", () => {
  it("assigns hostile markup as text, never as HTML", () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const had = "document" in globalThis;
    const previous = globals["document"];
    globals["document"] = {
      createElement: (tag: string): FakeNode => ({
        tagName: tag,
        textContent: "",
        innerHTML: "KEEP",
        className: "",
      }),
    };
    try {
      const parent = { appendChild: () => {} } as unknown as ParentNode;
      const hostile = `<img src=x onerror="window.__xss=1">evil</img>`;
      const node = appendTextChild(parent, "span", hostile, "n") as unknown as FakeNode;
      assert.equal(node.textContent, hostile);
      assert.equal(node.innerHTML, "KEEP", "nothing reaches the HTML parser");
      assert.equal(node.className, "n");
    } finally {
      if (had) globals["document"] = previous;
      else delete globals["document"];
    }
  });
});
