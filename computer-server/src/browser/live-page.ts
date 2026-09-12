/** Portions derived from OpenBot agent-computer/src/live-page.ts (MIT). */

export const MAX_TABS = 20;

/** Enough of a page for the choice. Keeps this file independent of Playwright. */
type OpenPage = { isClosed(): boolean; url?(): string };

/** Newest open page wins so an OAuth popup becomes the live view; closed pages are skipped. */
export function chooseLivePage<T extends OpenPage>(
  opened: readonly T[],
): T | undefined {
  for (let index = opened.length - 1; index >= 0; index -= 1) {
    const page = opened[index];
    if (page && !page.isClosed()) return page;
  }
  return undefined;
}

/**
 * Page to close when open tabs exceed MAX_TABS.
 * Agent: the incoming page (existing cap).
 * Human: never a protected page (action, relay, live, incoming) —
 * oldest unprotected about:blank instead, or none. A page without
 * url() is not blank and is never closed.
 */
export function chooseTabCapClose<T extends OpenPage>(
  opened: readonly T[],
  incoming: T,
  human: boolean,
  protectedPages: readonly (T | null | undefined)[] = [],
): T | undefined {
  let open = 0;
  for (const page of opened) {
    if (page && !page.isClosed()) open += 1;
  }
  if (open <= MAX_TABS) return undefined;
  if (!human) return incoming;
  for (const page of opened) {
    if (!page || page.isClosed() || page === incoming) continue;
    if (protectedPages.some((held) => held === page)) continue;
    if (page.url?.() === "about:blank") return page;
  }
  return undefined;
}
