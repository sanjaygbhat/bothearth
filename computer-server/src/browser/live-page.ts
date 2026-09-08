/** Portions derived from OpenBot agent-computer/src/live-page.ts (MIT). */

export const MAX_TABS = 5;

/** Enough of a page for the choice. Keeps this file independent of Playwright. */
type OpenPage = { isClosed(): boolean };

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
