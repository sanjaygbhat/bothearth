import { cpSync, mkdirSync } from "node:fs";

for (const path of [
  "config/example.yaml",
  "tools/schemas",
  "ui/index.html",
  "ui/tokens.css",
  "ui/base.css",
  "ui/shell.css",
  "ui/home.css",
  "ui/settings.css",
  "ui/task.css",
  "ui/fonts",
]) {
  cpSync(new URL(`../src/${path}`, import.meta.url), new URL(`../dist/${path}`, import.meta.url), { recursive: true });
}

// The UI serves the brand mark from /brand/mark.svg and asks for nothing else;
// the Mac app copies its own from assets/brand/ at build time.
mkdirSync(new URL("../dist/ui/brand/", import.meta.url), { recursive: true });
cpSync(new URL("../assets/brand/mark.svg", import.meta.url), new URL("../dist/ui/brand/mark.svg", import.meta.url));
