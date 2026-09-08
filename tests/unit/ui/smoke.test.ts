import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createUiStaticHandler,
  extractAssetRefs,
  resolveUiRoots,
  uiReferencedAssets,
} from "../../../src/ui/static.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("ui static smoke", () => {
  it("builds UI ESM then serves index.html and every referenced asset with 200", async () => {
    const build = spawnSync("npx", ["tsc", "-p", "tsconfig.json"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
    });
    assert.equal(build.status, 0, build.stderr || build.stdout);

    const roots = resolveUiRoots({
      srcDir: join(ROOT, "src/ui"),
      distDir: join(ROOT, "dist/ui"),
    });
    const handler = createUiStaticHandler(roots);
    const server = createServer((req, res) => {
      if (!handler(req, res)) {
        res.statusCode = 404;
        res.end("missing");
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const base = `http://127.0.0.1:${addr.port}`;

    try {
      const indexRes = await fetch(`${base}/`);
      assert.equal(indexRes.status, 200, "index.html");
      assert.match(
        indexRes.headers.get("content-security-policy") ?? "",
        /script-src 'self'/,
      );
      const html = await indexRes.text();
      assert.match(html, /<script type="module" src="\/main\.js">/);
      assert.doesNotMatch(html, /innerHTML/);

      const refs = new Set([
        ...uiReferencedAssets().filter((p) => p !== "/"),
        ...extractAssetRefs(html),
      ]);
      assert.ok(refs.has("/main.js"));
      // Every view sheet, so a package that dropped one fails here rather than
      // painting an unstyled screen (static.ts uiReferencedAssets).
      for (const sheet of ["/tokens.css", "/base.css", "/shell.css", "/home.css", "/task.css", "/settings.css"]) {
        assert.ok(refs.has(sheet), `${sheet} is not a referenced asset`);
      }

      for (const ref of refs) {
        const res = await fetch(`${base}${ref}`);
        assert.equal(res.status, 200, `asset ${ref}`);
        if (ref.endsWith(".js")) {
          // Comments carry example imports; a module graph does not.
          const body = (await res.text())
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "");
          // Both spellings: `from "x"`, and the bare `import "x"` a module that
          // is imported only for its side effects compiles to. main.js is now
          // almost entirely the second kind, so missing it would mean walking
          // nothing at all.
          const specifiers = [
            ...body.matchAll(/\bfrom\s*["']([^"']+)["']/g),
            ...body.matchAll(/\bimport\s*\(?\s*["']([^"']+)["']/g),
          ];
          for (const match of specifiers) {
            const dependency = new URL(match[1]!, `${base}${ref}`);
            assert.equal(dependency.origin, base, `external module ${dependency}`);
            refs.add(dependency.pathname);
          }
        }
      }
      // The live protocol is shared with the daemon and reached through a
      // path outside dist/ui, so the walk has to be able to leave the folder.
      assert.ok(refs.has("/protocol/live.js"));
      assert.equal((await fetch(`${base}/daemon/server.js`)).status, 404);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
