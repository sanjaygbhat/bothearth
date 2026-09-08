/**
 * Static asset serving for the daemon: HTML/CSS from src/ui, compiled ESM from
 * dist/ui.
 */
import { createReadStream, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const UI_SRC_DIR = fileURLToPath(new URL("./", import.meta.url));
/** When running from dist/ui/static.js, sources live at ../../src/ui */
const REPO_UI_SRC = normalize(join(UI_SRC_DIR, "..", "..", "src", "ui"));
const REPO_UI_DIST = normalize(join(UI_SRC_DIR, "..", "..", "dist", "ui"));
/** Brand assets are shared with the native shell and the site; served at /brand/*. */
const REPO_BRAND_DIR = normalize(join(UI_SRC_DIR, "..", "..", "assets", "brand"));

/** img blob/data is needed for the canvas frame draw; nothing else is relaxed. */
const UI_CSP =
  "default-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; connect-src 'self'; img-src 'self' blob: data:; style-src 'self'; base-uri 'self'; form-action 'self'";

export type UiStaticRoots = {
  srcDir?: string;
  distDir?: string;
};

export function resolveUiRoots(opts: UiStaticRoots = {}): {
  srcDir: string;
  distDir: string;
} {
  const srcDir =
    opts.srcDir ??
    (existsSync(join(UI_SRC_DIR, "index.html")) ? UI_SRC_DIR : REPO_UI_SRC);
  const distDir =
    opts.distDir ??
    (existsSync(join(UI_SRC_DIR, "main.js")) ? UI_SRC_DIR : REPO_UI_DIST);
  return { srcDir, distDir };
}

/**
 * Paths referenced from index.html, and thus required 200s.
 *
 * Every shipped stylesheet is listed. A view sheet that is missing from a
 * package does not fail loudly — the screen simply paints unstyled — so the
 * packaging smoke test is the only thing that can catch it, and it can only
 * catch what is named here. Add the sheet here whenever you add one.
 */
export function uiReferencedAssets(): string[] {
  return [
    "/",
    "/tokens.css",
    "/base.css",
    "/shell.css",
    "/home.css",
    "/task.css",
    "/settings.css",
    "/main.js",
    "/brand/mark.svg",
    "/fonts/fraunces-latin-wght.woff2",
  ];
}

/** Bundled next to index.html once packaged; from the repo when running from source. */
function brandDir(srcDir: string): string {
  const bundled = join(srcDir, "brand");
  return existsSync(bundled) ? bundled : REPO_BRAND_DIR;
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".map":
      return "application/json";
    case ".svg":
      return "image/svg+xml";
    case ".woff2":
      return "font/woff2";
    case ".woff":
      return "font/woff";
    case ".ttf":
      return "font/ttf";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    default:
      return "application/octet-stream";
  }
}

/**
 * Join under a root and refuse to leave it, after resolving symlinks.
 *
 * `normalize` cancels `..` but knows nothing about links, and `/brand/*` is
 * served unauthenticated, so the resolved real path is re-checked against the
 * root's own real path and a symlink is refused outright.
 */
function safeJoin(root: string, rel: string): string | null {
  const cleaned = rel.replace(/^\/+/, "").replaceAll("\0", "");
  const full = normalize(join(root, cleaned));
  const rootNorm = normalize(root.endsWith(sep) ? root : root + sep);
  if (full !== normalize(root) && !full.startsWith(rootNorm)) return null;

  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  if (!existsSync(full)) return full;
  try {
    // `lstat`, not `stat`: a link is refused for being a link, whatever it
    // points at, so nothing depends on where it happens to land today.
    if (lstatSync(full).isSymbolicLink()) return null;
    const realFull = realpathSync(full);
    const realRootPrefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (realFull !== realRoot && !realFull.startsWith(realRootPrefix)) return null;
    return realFull;
  } catch {
    return null;
  }
}

function mapUrlToFile(
  urlPath: string,
  roots: UiStaticRoots = {},
): { filePath: string; type: string } | null {
  const { srcDir, distDir } = resolveUiRoots(roots);
  const pathOnly = urlPath.split("?")[0] ?? "/";
  if (pathOnly === "/" || pathOnly === "/index.html") {
    const filePath = join(srcDir, "index.html");
    if (!existsSync(filePath)) return null;
    return { filePath, type: contentType(filePath) };
  }
  if (pathOnly.startsWith("/brand/")) {
    const full = safeJoin(brandDir(srcDir), pathOnly.slice("/brand".length));
    if (full && existsSync(full) && statSync(full).isFile()) {
      return { filePath: full, type: contentType(full) };
    }
    return null;
  }
  if (pathOnly.endsWith(".js") || pathOnly.endsWith(".mjs")) {
    // The live protocol is shared with the daemon, so it is served from
    // dist/protocol rather than dist/ui.
    if (pathOnly === "/protocol/live.js") {
      const filePath = join(distDir, "..", pathOnly.slice(1));
      return existsSync(filePath) ? { filePath, type: contentType(filePath) } : null;
    }
    const rel = pathOnly.replace(/^\/+/, "");
    const fromDist = safeJoin(distDir, rel);
    if (fromDist && existsSync(fromDist) && statSync(fromDist).isFile()) {
      return { filePath: fromDist, type: contentType(fromDist) };
    }
    return null;
  }
  // The referenced-asset list is the allowlist: a directory walk here would
  // serve any file under src/ui unauthenticated.
  if (!servableFromSrc(pathOnly)) return null;
  const fromSrc = safeJoin(srcDir, pathOnly);
  if (fromSrc && existsSync(fromSrc) && statSync(fromSrc).isFile()) {
    return { filePath: fromSrc, type: contentType(fromSrc) };
  }
  return null;
}

/** Exactly what index.html links, plus the font files the sheets pull in. */
function servableFromSrc(pathOnly: string): boolean {
  if (uiReferencedAssets().includes(pathOnly)) return true;
  // Fonts are referenced from inside a stylesheet rather than from the HTML,
  // and there is more than one weight/format, so the directory is allowed —
  // but only for font files, and `safeJoin` still refuses to leave it.
  return /^\/fonts\/[A-Za-z0-9._-]+\.(woff2|woff|ttf|otf)$/.test(pathOnly);
}

export function createUiStaticHandler(roots: UiStaticRoots = {}) {
  return function uiStaticHandler(
    req: IncomingMessage,
    res: ServerResponse,
  ): boolean {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    const url = req.url ?? "/";
    const pathOnly = url.split("?")[0] ?? "/";
    if (
      pathOnly.startsWith("/api/") ||
      pathOnly === "/healthz" ||
      pathOnly === "/mcp"
    ) {
      return false;
    }
    const mapped = mapUrlToFile(pathOnly, roots);
    if (!mapped) return false;
    res.statusCode = 200;
    res.setHeader("Content-Type", mapped.type);
    res.setHeader("Content-Security-Policy", UI_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Cache-Control",
      pathOnly.startsWith("/fonts/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    );
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    createReadStream(mapped.filePath).pipe(res);
    return true;
  };
}

/** Extract same-origin asset refs from index.html for smoke checks. */
export function extractAssetRefs(html: string): string[] {
  const refs = new Set<string>();
  const re = /\b(?:src|href)=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const ref = m[1];
    if (
      !ref ||
      ref.startsWith("#") ||
      ref.startsWith("http:") ||
      ref.startsWith("https:")
    ) {
      continue;
    }
    if (ref.startsWith("/")) refs.add(ref);
  }
  return [...refs];
}
