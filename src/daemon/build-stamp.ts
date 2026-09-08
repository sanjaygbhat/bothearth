/**
 * Content stamp for the images `POST /api/v1/runtime/prepare` builds.
 *
 * Staleness judged by the Dockerfile's mtime misses a change that adds a
 * source file the Dockerfile copies in, so the stamp hashes the build *inputs*
 * instead. It is stamped onto the image as a label at build time and compared
 * on every readiness poll; an image whose label differs from (or predates) the
 * daemon's own stamp is stale, and the owner is told its computer needs an
 * update.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const BUILD_STAMP_LABEL = "org.modelbot.build-stamp";

export type StampImage = "computer" | "shell" | "proxy";

/**
 * Everything each Dockerfile copies in, plus the Dockerfile itself. Widening a
 * COPY line without widening this list is what produced the bug above, so the
 * entries deliberately mirror the `COPY` directives one-for-one.
 */
export const STAMP_INPUTS: Record<StampImage, readonly string[]> = {
  computer: ["Dockerfile.computer", "computer-server", "src/protocol", "src/types", "src/tools", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "sandbox/Moby-LICENSE.txt", "sandbox/Moby-NOTICE.txt"],
  shell: ["Dockerfile.shell", "computer-server", "src/protocol", "src/types", "src/tools", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"],
  proxy: ["Dockerfile.proxy", "src/proxy", "package.json", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"],
};

/** Never part of an image: installed at build time from the lockfile, or noise. */
const SKIP = new Set(["node_modules", ".git", ".DS_Store"]);

function hashInto(hash: ReturnType<typeof createHash>, root: string, rel: string): void {
  let stat;
  try {
    stat = statSync(join(root, rel));
  } catch {
    // A missing input is itself a fact about this tree; record it and move on
    // rather than throwing readiness off a cliff.
    hash.update(`${rel}\0missing\0`);
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(join(root, rel)).sort()) {
      if (SKIP.has(entry)) continue;
      hashInto(hash, root, `${rel}/${entry}`);
    }
    return;
  }
  if (!stat.isFile()) return;
  hash.update(`${rel}\0`);
  hash.update(createHash("sha256").update(readFileSync(join(root, rel))).digest());
}

const cache = new Map<string, string>();

/**
 * Stable 16-hex digest of one image's build inputs. Cached per process: the
 * daemon's own files do not change under it while it runs, and readiness polls
 * every 2 s.
 */
export function buildStamp(image: StampImage, root: string): string {
  const key = `${image}\0${root}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const hash = createHash("sha256");
  for (const rel of STAMP_INPUTS[image]) hashInto(hash, root, rel);
  const stamp = hash.digest("hex").slice(0, 16);
  cache.set(key, stamp);
  return stamp;
}

/** Test seam only. */
export function clearBuildStampCache(): void {
  cache.clear();
}
