import type { BrowserContext, CDPSession, Page, Route } from "playwright";
import { originMatchesPattern } from "../../../src/protocol/origin.ts";

interface NavigationDenied { url: string; reason: string; initial_popup?: boolean }

/** Top-level navigation guard. Subresource traffic remains the proxy's responsibility. */
export class NavigationGuard {
  private origins: string[] | null = null;
  private allowPublicNavigation = false;
  private denied: NavigationDenied | null = null;
  private sessions = new Map<Page, Promise<CDPSession>>();

  private readonly human: () => boolean;
  constructor(human: () => boolean) { this.human = human; }

  setPolicy(origins: string[], allowPublicNavigation = false): void {
    this.origins = [...origins];
    this.allowPublicNavigation = allowPublicNavigation;
  }
  consumeDenied(): NavigationDenied | null {
    const denied = this.denied;
    this.denied = null;
    return denied;
  }
  blocksInitialPopups(): boolean { return this.active(); }
  denyInitialPopup(url: string): void {
    this.refuse(url, "Initial agent popups are blocked; use browser_tabs new or browser_navigate.", true);
  }
  private active(): boolean { return this.origins !== null && !this.human(); }
  private permitted(url: string, method = "GET"): boolean {
    if (!this.active() || url === "about:blank") return true;
    try {
      const destination = new URL(url);
      return ["http:", "https:"].includes(destination.protocol) &&
        ((this.allowPublicNavigation && (method === "GET" || method === "HEAD")) ||
          this.origins!.some((origin) => originMatchesPattern(destination.origin, origin)));
    } catch { return false; }
  }
  private refuse(url: string, reason: string, initial_popup = false): void {
    this.denied ??= { url, reason, ...(initial_popup ? { initial_popup: true } : {}) };
  }

  async install(context: BrowserContext): Promise<void> {
    await context.route("**/*", (route) => this.route(context, route));
  }

  private async route(context: BrowserContext, route: Route): Promise<void> {
    const request = route.request();
    if (!request.isNavigationRequest()) { await route.continue(); return; }
    let page: Page;
    try {
      const frame = request.frame();
      if (frame.parentFrame()) { await route.continue(); return; }
      page = frame.page();
    } catch {
      // A popup's page is unavailable until its first response, too late to guard redirects.
      if (this.active()) {
        this.denyInitialPopup(request.url());
        await route.abort("aborted");
        return;
      }
      await route.continue();
      return;
    }
    // Cancellation preserves the source DOM; a browser error page would invalidate approved retries.
    if (!this.permitted(request.url(), request.method())) {
      this.refuse(request.url(), "Navigation destination is outside the declared origins.");
      await route.abort("aborted");
      return;
    }
    try {
      await this.attach(context, page);
      await route.continue();
    } catch {
      this.refuse(request.url(), "Navigation guard could not initialize.");
      await route.abort("aborted").catch(() => undefined);
    }
  }

  attach(context: BrowserContext, page: Page): Promise<CDPSession> {
    const existing = this.sessions.get(page);
    if (existing) return existing;
    const pending = (async () => {
      const cdp = await context.newCDPSession(page);
      const { frameTree } = await cdp.send("Page.getFrameTree");
      const mainFrame = frameTree.frame.id;
      cdp.on("Fetch.requestPaused", (event) => {
        void (async () => {
          const denied = event.frameId === mainFrame && !this.permitted(event.request.url, event.request.method);
          if (denied) this.refuse(event.request.url, "Navigation destination is outside the declared origins.");
          await cdp.send(denied ? "Fetch.failRequest" : "Fetch.continueRequest", {
            requestId: event.requestId,
            ...(denied ? { errorReason: "Aborted" } : {}),
          });
        })().catch(async () => {
          // Never continue a navigation if policy evaluation or interception fails.
          this.refuse(event.request.url, "Navigation interception failed.");
          await cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Aborted" }).catch(() => undefined);
          await page.close().catch(() => undefined);
        });
      });
      // Playwright route callbacks omit server-redirect hops. CDP sees each hop.
      await cdp.send("Fetch.enable", { patterns: [{ resourceType: "Document", requestStage: "Request" }] });
      page.once("close", () => this.sessions.delete(page));
      return cdp;
    })();
    this.sessions.set(page, pending);
    return pending;
  }

  clear(): void { this.sessions.clear(); this.denied = null; }
}
