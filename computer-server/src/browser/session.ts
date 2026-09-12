import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Browser, BrowserContext, CDPSession, Frame, LaunchOptions, Page } from "playwright";
import { chromium } from "playwright";
import type { LiveProducer } from "../../../src/protocol/live.ts";
import type {
  BrowserScreenshotOutput,
  BrowserSnapshotOutput,
  LiveMode,
  ScreencastFrameHeader,
  ToolResult,
} from "../../../src/types/contracts.ts";
import { toolError } from "../../../src/protocol/errors.ts";
import {
  assertQuarantineMount,
  downloadsDir,
  jailPath,
  profileDir,
  workspaceRoot,
} from "../jail.ts";
import {
  SECRET_MASK_SELECTORS,
  type SensitiveField,
  markSecretFields,
  redactSnapshotYaml,
  redactUrl,
} from "../redact.ts";
import { KeyboardRelay, keyChord, type RelayKey } from "./live-key.ts";
import { Desktop, DESKTOP } from "./desktop.ts";
import { NavigationGuard } from "./navigation-guard.ts";
import { chooseLivePage, chooseTabCapClose, MAX_TABS } from "./live-page.ts";

export { chooseLivePage, chooseTabCapClose, MAX_TABS } from "./live-page.ts";

const VIEWPORT = { width: 1280, height: 720 };
/** Normal Chromium, with only container privacy and transport settings. */
export const LAUNCH_ARGS = [
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--no-first-run",
  "--no-default-browser-check",
  // No OS keyring in the container, and nothing may be written to one anyway.
  "--password-store=basic",
  // A human at the keyboard must be able to sign in to Google. Playwright's
  // automation override otherwise reports navigator.webdriver true; not a user-agent spoof.
  "--disable-blink-features=AutomationControlled",
];

/**
 * Chrome's password manager and form autofill, off in the profile itself.
 * A credential the browser fills on its own is one no gated tool call asked
 * for. Use preferences rather than relying on automation switches:
 * the profile is persistent, so this has to survive every restart, and it is a
 * pref that Chromium's own settings screen reads.
 */
const NO_CREDENTIAL_PREFS = {
  credentials_enable_service: false,
  credentials_enable_autosignin: false,
  profile: { password_manager_enabled: false },
  autofill: { profile_enabled: false, credit_card_enabled: false },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Writes those prefs into the profile, keeping whatever else is already there. */
export function disableCredentialStorage(profile: string): void {
  const dir = join(profile, "Default");
  const file = join(dir, "Preferences");
  let prefs: Record<string, unknown> = {};
  try {
    prefs = asRecord(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    /* No profile yet, or a file Chromium will rewrite from scratch anyway. */
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({
    ...prefs,
    ...NO_CREDENTIAL_PREFS,
    profile: { ...asRecord(prefs.profile), ...NO_CREDENTIAL_PREFS.profile },
    autofill: { ...asRecord(prefs.autofill), ...NO_CREDENTIAL_PREFS.autofill },
  }));
}

/** Playwright rejects a non-IANA zone, and the failure reads as a seccomp fault. */
function hostTimeZone(): string | undefined {
  const tz = process.env.TZ;
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}
const JPEG_Q = 60;
const SNAP_MAX = 16_000;
const DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_ID = /^download_[a-f0-9]{24}$/;
/** Interactive-control cap; overflow is reported via `truncated` / `omitted.nodes`. */
export const SNAPSHOT_CONTROL_CAP = 200;
const LANDMARK_ROLES = new Set(["document", "region", "main", "navigation"]);

interface QuarantineItem {
  id: string;
  name: string;
  size: number;
  content_type: string | null;
  downloaded_at: string;
  sha256: string | null;
}

function sanitizeDownloadName(name: string): string {
  const clean = (name || "download").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return !clean || clean === "." || clean === ".." ? "download" : clean;
}

type Snap = {
  id: string;
  refs: Set<string>;
  bindings: Map<string, { role: string; name: string; nth: number }>;
  /** Page this snapshot was taken on; ref actions must target it, not livePage. */
  page: Page;
};

/** Playwright-free: keep heading (hybrid ladder), drop landmark wrappers, cap ref-bearing controls. */
export function filterInteractiveYaml(
  yaml: string,
  cap = SNAPSHOT_CONTROL_CAP,
): { yaml: string; omittedNodes: number } {
  const kept: string[] = [];
  let omittedNodes = 0;
  let controls = 0;
  for (const ln of yaml.split("\n")) {
    const role = ln.match(/^\s*-\s*(\w+)/)?.[1];
    // Ref-bearing landmarks (main/region/…) must stay clickable; test refs first.
    if (/\[ref=e\d+\]/.test(ln)) {
      if (controls < cap) {
        kept.push(ln);
        controls += 1;
      } else {
        omittedNodes += 1;
      }
      continue;
    }
    if (role && LANDMARK_ROLES.has(role)) continue;
    if (role === "heading") kept.push(ln);
  }
  return { yaml: kept.join("\n"), omittedNodes };
}

type RefLocator = { count(): Promise<number> };

/** Bindings fallback only: `count()===0` → `E_STALE_REF`. Unknown snap/ref unchanged (no probe). */
export async function resolveSnapRef<L extends RefLocator>(
  snaps: ReadonlyMap<string, Pick<Snap, "refs" | "bindings">>,
  page: {
    locator(selector: string): L;
    getByRole(
      role: "button",
      options: { name: string },
    ): { nth(index: number): L };
  },
  snapshotId: string,
  ref: string,
): Promise<{ ok: true; locator: L } | ToolResult> {
  const snap = snaps.get(snapshotId);
  if (!snap) {
    return toolError("E_STALE_REF", undefined, { snapshot_id: snapshotId, ref });
  }
  if (snap.refs.has(ref)) {
    return { ok: true, locator: page.locator(`aria-ref=${ref}`) };
  }
  const b = snap.bindings.get(ref);
  if (!b) {
    return toolError("E_STALE_REF", undefined, { snapshot_id: snapshotId, ref });
  }
  const locator = page.getByRole(b.role as "button", { name: b.name }).nth(b.nth);
  if ((await locator.count()) === 0) {
    return toolError("E_STALE_REF", undefined, { snapshot_id: snapshotId, ref });
  }
  return { ok: true, locator };
}

/**
 * Playwright 1.59 locator options have no `signal`; protocol `tObject` silently
 * drops unknown keys, so spreading `{signal}` never cancels an in-flight click.
 * Already-aborted → never invoke. In-flight acts must be tracked and awaited
 * (see `BrowserSession.abortActs`) before takeover grant ack (DECISIONS R2).
 */
export async function actWithSignal<T>(
  signal: AbortSignal,
  fn: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  }
  return fn();
}

/** Chromium's profile lock. Only it may create these; only it cleans them up. */
const SINGLETON_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"] as const;
/** Both wordings Chromium uses when the lock stops a launch. */
const PROFILE_IN_USE = /in use by another|ProcessSingleton|SingletonLock/i;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const TARGET_CRASHED = /Target crashed/i;
const TARGET_CLOSED = /Target closed/i;

export const BROWSER_RESTARTED_MESSAGE = "The browser was restarted; take a new snapshot.";

function restartedError(): Error {
  return Object.assign(new Error(BROWSER_RESTARTED_MESSAGE), { code: "E_IO" as const });
}

/** Live action page closed/dead, or Playwright `Target crashed`. Snapshot-handle `Target closed` is not a crash. */
export function isCrashedTarget(err: unknown, livePage?: { isClosed(): boolean } | null): boolean {
  try {
    if (livePage?.isClosed()) return true;
  } catch {
    return true;
  }
  return TARGET_CRASHED.test(errorText(err));
}

function contextAlive(ctx: BrowserContext | null): boolean {
  if (!ctx) return false;
  try {
    ctx.pages();
    return true;
  } catch {
    return false;
  }
}

export async function withCrashedTargetRetry<T>(
  session: BrowserSession,
  act: () => Promise<T>,
  retry = true,
): Promise<T> {
  try {
    return await act();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    if (!isCrashedTarget(err, session.page)) throw err;
    const kind = await session.recoverCrashedPage();
    if (kind === "browser" || !retry) throw restartedError();
    try {
      return await act();
    } catch (retryErr) {
      if (retryErr instanceof Error && retryErr.name === "AbortError") throw retryErr;
      if (isCrashedTarget(retryErr, session.page)) throw restartedError();
      throw retryErr;
    }
  }
}

async function recoverActResult(
  session: BrowserSession,
  act: () => Promise<ToolResult>,
): Promise<ToolResult> {
  try {
    return await withCrashedTargetRetry(session, act, false);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    if (err instanceof Error && err.message === BROWSER_RESTARTED_MESSAGE) {
      return toolError("E_IO", BROWSER_RESTARTED_MESSAGE);
    }
    throw err;
  }
}

/** Resolve-time aria-ref miss only. Act-path Playwright teardown stays E_IO. */
const STALE_LOCATOR = /no longer matched|not found in the current page snapshot/i;
/** count() while click's noWaitAfter navigation is still tearing down. Resolve-only. */
const RESOLVE_TEARDOWN = /execution context was destroyed|not attached/i;

function isStaleLocatorError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return false;
  return STALE_LOCATOR.test(errorText(err));
}

function removeSingletons(dir: string): void {
  for (const name of SINGLETON_FILES) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      // Absent is the normal case, and an unremovable lock surfaces at launch.
    }
  }
}

/**
 * `SingletonLock` is a symlink named `<host>-<pid>` by the Chromium that holds
 * the profile. Ours is the only Chromium allowed on this profile, so a link
 * naming another host or a dead pid belongs to a container that is gone.
 */
function singletonOwnerAlive(dir: string): boolean {
  let link: string;
  try {
    link = readlinkSync(join(dir, "SingletonLock"));
  } catch {
    return false;
  }
  const owner = /^(.*)-(\d+)$/.exec(link);
  if (!owner || owner[1] !== hostname()) return false;
  try {
    process.kill(Number(owner[2]), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Drop the profile lock left by a Chromium that was killed before it could
 * clean up. The profile is a volume that outlives its container, so without
 * this every launch after a SIGTERM-with-browser-alive exits with "the profile
 * appears to be in use by another Chromium process" and nothing in the product
 * can recover.
 */
export function clearStaleSingletons(dir: string): void {
  if (singletonOwnerAlive(dir)) return;
  removeSingletons(dir);
}

/**
 * A lock whose owner is still alive by the check above but not actually
 * Chromium — pid reuse inside a restarted container — only shows up as a launch
 * failure. Clear it unconditionally then and try once more.
 */
export async function launchWithLockRecovery<T>(
  dir: string,
  open: () => Promise<T>,
): Promise<T> {
  try {
    return await open();
  } catch (error) {
    if (!PROFILE_IN_USE.test(errorText(error))) throw error;
    removeSingletons(dir);
    try {
      return await open();
    } catch (retry) {
      throw Object.assign(
        new Error(
          `Chromium says the profile at ${dir} is in use by another Chromium, and still says so after ${SINGLETON_FILES.join(", ")} were removed. ${errorText(retry)}`,
          { cause: retry },
        ),
        { profileLocked: true },
      );
    }
  }
}

/** Playwright 1.59 screenshot options have no `fonts: "hide"`; retry the one flake. */
const FONT_LOAD_WAIT = /waiting for fonts to load/i;

export async function withFontLoadRetry<T>(take: () => Promise<T>): Promise<T> {
  try {
    return await take();
  } catch (error) {
    if (!FONT_LOAD_WAIT.test(errorText(error))) throw error;
    return await take();
  }
}

export class BrowserSession {
  private readonly navigation = new NavigationGuard(() => this.liveMode === "human");
  setNavigationPolicy(origins: string[], allowPublicNavigation = false): void { this.navigation.setPolicy(origins, allowPublicNavigation); }
  consumeNavigationDenied() { return this.navigation.consumeDenied(); }
  context: BrowserContext | null = null;
  /** Action target. Changes only via explicit `browser_tabs` (or start/close). */
  private actionPage: Page | null = null;
  get page(): Page | null {
    return this.actionPage;
  }
  set page(page: Page | null) {
    this.actionPage = page;
    if (this.liveMode === "agent") this.relayPage = page;
  }
  /** Screencast/live view. May follow the newest page (OAuth popup). */
  livePage: Page | null = null;
  /** Pre-bound to the stable action page; popup tracking never changes it. */
  relayPage: Page | null = null;
  cdp: CDPSession | null = null;
  casting = false;
  seq = 0;
  liveMode: LiveMode = "agent";
  private liveKeyboard: { page: Page; relay: KeyboardRelay } | null = null;
  epoch = 1;
  snaps = new Map<string, Snap>();
  onLiveFrame: ((h: ScreencastFrameHeader, jpeg: Uint8Array) => void) | null = null;
  onLiveControl: ((msg: LiveProducer) => void) | null = null;
  actAbort = new AbortController();
  private inFlightActs = new Set<Promise<unknown>>();
  private wiredPages = new WeakSet<Page>();
  /** Chrome for Testing writes Crashpad settings outside the profile; keep them
   * private, ephemeral, and cleaned up on close. */
  private configHome = "";
  private desktop: Desktop | null = null;
  private downloadQuarantines = new WeakMap<object, Promise<Record<string, unknown>>>();

  async start(): Promise<void> {
    assertQuarantineMount();
    mkdirSync(profileDir(), { recursive: true });
    mkdirSync(workspaceRoot(), { recursive: true });
    clearStaleSingletons(profileDir());
    disableCredentialStorage(profileDir());
    this.configHome ||= mkdtempSync(join(tmpdir(), "modelbot-chromium-"));

    if (process.env.MODELBOT_DESKTOP === "1" && !this.desktop) {
      this.desktop = new Desktop(this.configHome);
      await this.desktop.start();
    }
    const args = [...LAUNCH_ARGS];
    // A private pipe exposes no debugging TCP port. Keep Chromium's real UA
    // and browser features instead of Playwright's test-oriented defaults.
    args.push("--remote-debugging-pipe", `--user-data-dir=${profileDir()}`);
    if (this.desktop) args.push("--window-position=0,0", "--window-size=1280,820");
    else args.push("--headless=new");
    const proxy = process.env.MODELBOT_PROXY_SERVER || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (!proxy) throw new Error("browser: MODELBOT_PROXY_SERVER is required");
    const u = new URL(proxy);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error("browser: invalid proxy scheme");
    }
    args.push(`--proxy-server=${u.protocol}//${u.host}`);
    const bypass = process.env.MODELBOT_PROXY_BYPASS ?? "localhost,127.0.0.1";
    args.push(`--proxy-bypass-list=${bypass.replace(/,/g, ";")}`);

    const launch: LaunchOptions = {
      // The computer image installs the distribution's normal Chromium.
      // Host-only tests may use Playwright's full Chromium installation.
      channel: "chromium",
      executablePath: process.env.MODELBOT_CHROMIUM_EXECUTABLE,
      headless: !this.desktop,
      chromiumSandbox: true,
      // Chrome for Testing writes Crashpad settings outside user-data-dir.
      // Keep those files private and ephemeral under the writable container tmpfs.
      env: { ...process.env, ...this.desktop?.env, XDG_CONFIG_HOME: this.configHome },
      // true drops Playwright's --enable-automation and the rest of its
      // test-browser defaults. Do not spoof the user agent.
      ignoreDefaultArgs: true,
      // Playwright's own signal handlers kill Chromium and exit the process
      // before it can unlink its profile lock. The rpc loop closes the context
      // on those signals instead (computer-server/src/rpc-loop.ts).
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    };
    const launchFailed = (error: unknown): never => {
      // The lock failure already names its own cause; the sandbox hint would bury it.
      if ((error as { profileLocked?: boolean }).profileLocked) throw error;
      throw new Error(
        `Chromium sandbox launch failed; verify the host permits user namespaces and uses sandbox/seccomp-chromium.json with the chroot rule. Run bash scripts/image-smoke.sh on the host. ${errorText(error)}`,
        { cause: error },
      );
    };
    this.context = await launchWithLockRecovery(profileDir(), () =>
      chromium.launchPersistentContext(profileDir(), {
        ...launch,
        serviceWorkers: "block",
        viewport: this.desktop ? null : VIEWPORT,
        acceptDownloads: true,
        // Land downloads directly on the workspace bind mount.
        downloadsPath: downloadsDir(),
        args: [...args, "about:blank"],
        timezoneId: hostTimeZone(),
      }),
    ).catch(launchFailed);
    await this.navigation.install(this.context);
    this.context.on("page", (p) => {
      void this.onContextPageEvent(p);
    });
    for (const p of this.context.pages()) this.wirePage(p);
    this.page =
      chooseLivePage(this.context.pages()) ?? (await this.context.newPage());
    this.livePage = this.page;
    this.wirePage(this.page);
    await this.navigation.attach(this.context, this.page);
    await this.attachCdp(this.page);
  }

  /**
   * Refuse new click/type immediately. Playwright cannot cancel a locator action
   * already in flight — await those before takeover grant ack so a click cannot
   * land after the human is told they have control (DECISIONS R2 capture-before-ack).
   * Controller stays aborted until liveMode returns to agent.
   */
  abortActs(): Promise<void> {
    this.actAbort.abort();
    return Promise.allSettled([...this.inFlightActs]).then(() => undefined);
  }

  private async runAct<T>(fn: () => Promise<T>): Promise<T> {
    let tracked!: Promise<T>;
    tracked = actWithSignal(this.actAbort.signal, fn).finally(() => {
      this.inFlightActs.delete(tracked);
    });
    this.inFlightActs.add(tracked);
    return tracked;
  }

  /** HUMAN at open: a later agent/validating switch must not close this page. */
  private onContextPageEvent(page: Page): Promise<void> {
    const human = this.liveMode === "human";
    return this.onContextPage(page).catch(() => {
      if (human) return;
      void page.close().catch(() => undefined);
    });
  }

  private async onContextPage(page: Page): Promise<void> {
    if (this.navigation.blocksInitialPopups() && await page.opener()) {
      this.navigation.denyInitialPopup(page.url());
      await page.close();
      return;
    }
    this.wirePage(page);
    await this.navigation.attach(this.context!, page);
    const open = (this.context?.pages() ?? []).filter((p) => !p.isClosed());
    const excess = chooseTabCapClose(open, page, this.liveMode === "human", [
      this.page,
      this.relayPage,
      this.livePage,
      page,
    ]);
    if (excess) await excess.close().catch(() => undefined);
    if (page.isClosed()) return;
    if (this.liveMode === "human") await page.bringToFront().catch(() => undefined);
    await this.followLivePage();
  }

  private wirePage(page: Page): void {
    if (this.wiredPages.has(page)) return;
    this.wiredPages.add(page);
    this.wireDownloads(page);
    page.on("close", () => {
      void this.followLivePage();
    });
  }

  /** Follow newest page for screencast only. Action `page` stays put until browser_tabs. */
  private async followLivePage(): Promise<void> {
    if (this.liveMode !== "agent") return;
    const live = chooseLivePage(this.context?.pages() ?? []);
    if (!live) {
      this.livePage = null;
      return;
    }
    if (live === this.livePage) return;
    this.livePage = live;
    await this.attachCdp(live);
  }

  private wireDownloads(page: Page): void {
    page.on("download", async (dl) => {
      try {
        await this.quarantineDownloadOnce(dl);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("download saveAs failed", err);
      }
    });
  }

  private quarantineDownloadOnce(dl: { suggestedFilename(): string; saveAs(path: string): Promise<void> }): Promise<Record<string, unknown>> {
    let pending = this.downloadQuarantines.get(dl);
    if (!pending) {
      pending = this.quarantineDownload(dl);
      this.downloadQuarantines.set(dl, pending);
    }
    return pending;
  }

  private async quarantineDownload(dl: { suggestedFilename(): string; saveAs(path: string): Promise<void> }): Promise<Record<string, unknown>> {
    const basename = sanitizeDownloadName(dl.suggestedFilename());
    const id = `download_${randomBytes(12).toString("hex")}`;
    const path = `${downloadsDir()}/${id}-${basename}`;
    await dl.saveAs(path);
    const size = statSync(path).size;
    if (size > DOWNLOAD_MAX_BYTES) {
      unlinkSync(path);
      throw new Error(`download exceeds ${DOWNLOAD_MAX_BYTES} bytes`);
    }
    const bytes = await import("node:fs/promises").then((fs) => fs.readFile(path));
    const mime = sniffMime(bytes, basename);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return {
      id,
      basename,
      size,
      mime,
      sha256,
      downloaded_at: statSync(path).mtime.toISOString(),
      quarantined: true,
      path,
    };
  }

  private quarantineItem(filename: string): QuarantineItem | null {
    const match = /^(download_[a-f0-9]{24})-(.+)$/.exec(filename);
    if (!match) return null;
    let fd = -1;
    try {
      fd = openSync(`${downloadsDir()}/${filename}`, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile()) return null;
      const bytes = stat.size <= DOWNLOAD_MAX_BYTES ? readFileSync(fd) : null;
      return {
        id: match[1]!,
        name: sanitizeDownloadName(match[2]!),
        size: stat.size,
        content_type: bytes ? sniffMime(bytes, match[2]!) : null,
        downloaded_at: stat.mtime.toISOString(),
        sha256: bytes ? createHash("sha256").update(bytes).digest("hex") : null,
      };
    } catch {
      return null;
    } finally {
      if (fd >= 0) closeSync(fd);
    }
  }

  listQuarantine(): ToolResult {
    try {
      const items = readdirSync(downloadsDir(), { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => this.quarantineItem(entry.name))
        .filter((item): item is QuarantineItem => item !== null)
        .sort((a, b) => a.downloaded_at.localeCompare(b.downloaded_at));
      return { ok: true, data: { items } };
    } catch (err) {
      return toolError("E_IO", err instanceof Error ? err.message : String(err));
    }
  }

  promoteQuarantine(id: string): ToolResult {
    if (!DOWNLOAD_ID.test(id)) return toolError("E_POLICY", "invalid download id");
    const filename = readdirSync(downloadsDir()).find((name) => name.startsWith(`${id}-`));
    const item = filename ? this.quarantineItem(filename) : null;
    if (!filename || !item) return toolError("E_IO", "quarantined download not found");
    if (item.size > DOWNLOAD_MAX_BYTES) return toolError("E_POLICY", "download exceeds size cap");

    const jailed = jailPath(`${id}-${item.name}`);
    if (!("abs" in jailed)) return jailed;
    const source = `${downloadsDir()}/${filename}`;
    let sourceFd = -1;
    let destinationFd = -1;
    let destinationCreated = false;
    try {
      sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(sourceFd);
      if (!stat.isFile() || stat.size > DOWNLOAD_MAX_BYTES) {
        return toolError("E_POLICY", "invalid quarantined download");
      }
      destinationFd = openSync(
        jailed.abs,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      );
      destinationCreated = true;
      writeFileSync(destinationFd, readFileSync(sourceFd));
      fsyncSync(destinationFd);
      closeSync(destinationFd);
      destinationFd = -1;
      unlinkSync(source);
      return {
        ok: true,
        data: { ...item, workspace_path: jailed.abs, quarantined: false },
      };
    } catch (err) {
      if (destinationCreated) {
        try { unlinkSync(jailed.abs); } catch { /* best-effort partial-copy rollback */ }
      }
      return toolError("E_IO", err instanceof Error ? err.message : String(err));
    } finally {
      if (sourceFd >= 0) closeSync(sourceFd);
      if (destinationFd >= 0) closeSync(destinationFd);
    }
  }

  /** Marks and blacks out every credential field, and says what it found. */
  async maskSecrets(target?: Page): Promise<SensitiveField[]> {
    const pages = target
      ? [target]
      : (this.context?.pages() ?? [this.requirePage()]).filter(
          (page) => !page.isClosed(),
        );
    const found: SensitiveField[] = [];
    for (const page of pages) {
      found.push(...(await page.evaluate(markSecretFields, SECRET_MASK_SELECTORS)));
    }
    return found;
  }

  async attachCdp(page: Page): Promise<void> {
    try {
      await this.cdp?.detach();
    } catch {
      /* ignore */
    }
    this.cdp = await this.context!.newCDPSession(page);
    const cdp = this.cdp;
    const mode = this.liveMode;
    const epoch = this.epoch;
    cdp.on("Page.screencastFrame", async (evt) => {
      try {
        await cdp.send("Page.screencastFrameAck", { sessionId: evt.sessionId });
      } catch {
        /* ignore */
      }
      // This stream goes only to the authenticated operator UI. Model captures use
      // gated screenshot/snapshot RPCs and never consume these frames.
      if ((this.desktop && this.liveMode === "human") || !this.casting || !this.onLiveFrame || cdp !== this.cdp ||
          mode !== this.liveMode || epoch !== this.epoch) return;
      const jpeg = Buffer.from(evt.data, "base64");
      const m = evt.metadata as {
        offsetTop?: number;
        pageScaleFactor?: number;
        deviceWidth?: number;
        deviceHeight?: number;
        scrollOffsetX?: number;
        scrollOffsetY?: number;
        deviceScaleFactor?: number;
      };
      this.seq += 1;
      this.onLiveFrame(
        {
          v: 1,
          seq: this.seq,
          ts: Date.now(),
          mime: "image/jpeg",
          mode,
          epoch,
          target: "page",
          viewport: {
            w: VIEWPORT.width,
            h: VIEWPORT.height,
            dpr: m.deviceScaleFactor ?? 1,
          },
          meta: {
            offsetTop: m.offsetTop ?? 0,
            pageScaleFactor: m.pageScaleFactor ?? 1,
            deviceWidth: m.deviceWidth ?? VIEWPORT.width,
            deviceHeight: m.deviceHeight ?? VIEWPORT.height,
            scrollOffsetX: m.scrollOffsetX ?? 0,
            scrollOffsetY: m.scrollOffsetY ?? 0,
          },
        },
        new Uint8Array(jpeg),
      );
    });
    if (this.casting) await this.startCdpScreencast();
  }

  private async startCdpScreencast(): Promise<void> {
    const base: Record<string, unknown> = {
      format: "jpeg",
      quality: 70,
      maxWidth: 1280,
      maxHeight: 720,
      everyNthFrame: 1,
    };
    try {
      await this.cdp!.send("Page.startScreencast", {
        ...base,
        sendLastFrame: true,
      } as never);
    } catch {
      await this.cdp!.send("Page.startScreencast", base as never);
    }
  }

  setLiveMode(mode: LiveMode, bump = false): void {
    if (mode === "human" && this.relayPage?.isClosed()) this.relayPage = null;
    this.desktop?.stopStream();
    this.liveMode = mode;
    if (bump) this.epoch += 1;
    if (mode === "agent" && this.actAbort.signal.aborted) {
      this.actAbort = new AbortController();
    }
    if (mode === "agent") {
      const requester = this.page;
      this.relayPage = requester && !requester.isClosed() ? requester : null;
    }
  }

  async stopScreencast(): Promise<void> {
    this.desktop?.stopStream();
    this.casting = false;
    try {
      await this.cdp?.send("Page.stopScreencast");
    } catch {
      /* ignore */
    }
  }

  async startScreencast(): Promise<void> {
    if (this.desktop && this.liveMode === "human") {
      this.casting = true;
      const epoch = this.epoch;
      this.desktop.stream(jpeg => {
        if (!this.casting || this.liveMode !== "human" || epoch !== this.epoch) return;
        this.onLiveFrame?.({ v: 1, seq: ++this.seq, ts: Date.now(), mime: "image/jpeg", mode: "human", epoch, target: "desktop",
          viewport: { w: DESKTOP.width, h: DESKTOP.height, dpr: 1 }, meta: { offsetTop: 0, pageScaleFactor: 1, deviceWidth: DESKTOP.width, deviceHeight: DESKTOP.height, scrollOffsetX: 0, scrollOffsetY: 0 } }, jpeg);
      }, (status, reason) => {
        if (!this.casting || this.liveMode !== "human" || epoch !== this.epoch) return;
        this.onLiveControl?.({ v: 1, t: "producer", status, reason });
      });
      return;
    }
    const view = this.livePage ?? this.page;
    if (!this.cdp || !view) throw new Error("no cdp");
    await this.maskSecrets(view);
    await this.attachCdp(view);
    if (!this.casting) {
      this.casting = true;
      await this.startCdpScreencast();
    }
  }

  async close(): Promise<void> {
    await this.stopScreencast();
    await this.context?.close();
    this.desktop?.close();
    this.desktop = null;
    if (this.configHome) rmSync(this.configHome, { recursive: true, force: true });
    this.configHome = "";
    this.context = null;
    this.page = null;
    this.livePage = null;
    this.relayPage = null;
    this.cdp = null;
    this.navigation.clear();
  }

  requirePage(): Page {
    if (!this.page) throw new Error("browser not started");
    return this.page;
  }

  async recoverCrashedPage(): Promise<"page" | "browser"> {
    const crashed = this.page;
    let url = "";
    try {
      if (crashed) url = crashed.url();
    } catch {
      /* Target closed — URL may still have been read, or not. */
    }
    if (!contextAlive(this.context)) {
      await this.close().catch(() => undefined);
      await this.start();
      return "browser";
    }
    const ctx = this.context!;
    try {
      if (crashed && !crashed.isClosed()) await crashed.close().catch(() => undefined);
    } catch {
      /* already gone */
    }
    let next: Page;
    try {
      next = await ctx.newPage();
    } catch {
      await this.close().catch(() => undefined);
      await this.start();
      return "browser";
    }
    this.page = next;
    this.livePage = next;
    this.wirePage(next);
    if (url) {
      try {
        await next.goto(url, { waitUntil: "domcontentloaded" });
      } catch {
        await this.close().catch(() => undefined);
        await this.start();
        return "browser";
      }
    }
    await this.navigation.attach(ctx, next).catch(() => undefined);
    await this.attachCdp(next).catch(() => undefined);
    return "page";
  }

  /** HUMAN relay target is request-bound; a closed target never falls back. */
  liveTarget(): Page | null {
    const relay = this.relayPage;
    if (relay && !relay.isClosed()) return relay;
    return null;
  }

  /** Operator-only: leave a credential page without exposing it to the model. */
  async blankTab(): Promise<ToolResult> {
    let page = this.livePage ?? this.page;
    if (!page || page.isClosed()) {
      page = null;
      for (const tab of this.context?.pages() ?? []) {
        if (!tab.isClosed()) { page = tab; break; }
      }
    }
    if (!page) return toolError("E_IO", "no tab to clear");
    await page.goto("about:blank", { waitUntil: "domcontentloaded" });
    this.livePage = page;
    this.page = page;
    return { ok: true, data: { url: "about:blank" } };
  }

  async navigate(url: string, waitUntil: string | null): Promise<ToolResult> {
    const page = this.requirePage();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return toolError("E_POLICY", "invalid navigation URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return toolError("E_POLICY", `navigation scheme not allowed: ${parsed.protocol}`);
    }
    const wu =
      waitUntil === "load" ||
      waitUntil === "domcontentloaded" ||
      waitUntil === "networkidle" ||
      waitUntil === "commit"
        ? waitUntil
        : "domcontentloaded";
    let timedOut = false;
    // Host match is not a commit: a same-host goto that never commits leaves
    // page.url() at the previous document. Count only main-frame commits that
    // start after this goto.
    let committed = false;
    const onFrameNavigated = (frame: Frame) => {
      if (frame === page.mainFrame()) committed = true;
    };
    page.on("framenavigated", onFrameNavigated);
    try {
      await page.goto(url, { waitUntil: wu, timeout: 15_000 });
    } catch (err) {
      if (!(err instanceof Error) || err.name !== "TimeoutError") throw err;
      // Abort leftover subresource waits so a later snapshot is not stuck on
      // Playwright's in-flight navigation from the timed-out goto.
      await Promise.race([
        (async () => {
          let cdp = this.cdp;
          let created = false;
          if (!cdp) {
            try {
              cdp = await this.context!.newCDPSession(page);
              created = true;
            } catch {
              cdp = null;
            }
          }
          if (cdp) {
            await cdp.send("Page.stopLoading");
            if (created) await cdp.detach().catch(() => undefined);
            return;
          }
          await page.evaluate(() => window.stop());
        })().catch(() => undefined),
        sleep(1_500),
      ]);
      if (!committed) return toolError("E_IO", err.message);
      timedOut = true;
    } finally {
      page.off("framenavigated", onFrameNavigated);
    }
    if (!timedOut) {
      await page.waitForLoadState("load", { timeout: 5_000 }).catch(() => undefined);
    }
    if (this.livePage === page || this.livePage == null) {
      this.livePage = page;
      await this.attachCdp(page);
    }
    return {
      ok: true,
      data: {
        url: redactUrl(page.url()),
        title: timedOut
          ? await Promise.race([
              page.title().catch(() => ""),
              sleep(1_500).then(() => ""),
            ])
          : await page.title(),
        ...(timedOut ? { timed_out: true, wait_until: wu } : {}),
      },
    };
  }

  async snapshot(params: {
    scope: string | null;
    interactive_only: boolean | null;
    depth: number | null;
    max_chars: number | null;
  }): Promise<ToolResult<BrowserSnapshotOutput>> {
    return withCrashedTargetRetry(this, async () => {
    const page = this.requirePage();
    const interactive = params.interactive_only !== false;
    const maxChars = params.max_chars ?? SNAP_MAX;
    const root = params.scope
      ? page.locator(`aria-ref=${params.scope}`)
      : page.locator("body");

    const secrets = await this.maskSecrets();
    const secretLocators = page.locator(SECRET_MASK_SELECTORS);
    const originals = await secretLocators.evaluateAll((nodes) =>
      nodes.map((node) => ({
        value: "value" in node ? String((node as HTMLInputElement).value) : null,
        text: node instanceof HTMLElement && node.isContentEditable ? node.textContent : null,
      })),
    );
    await secretLocators.evaluateAll((nodes) => {
      for (const node of nodes) {
        if ("value" in node) (node as HTMLInputElement).value = "***";
        if (node instanceof HTMLElement && node.isContentEditable) node.textContent = "***";
      }
    });
    let yaml: string;
    try {
      yaml = await root.ariaSnapshot({ mode: "ai" } as { mode: "ai" });
    } finally {
      await secretLocators.evaluateAll((nodes, saved) => {
        nodes.forEach((node, index) => {
          const original = saved[index];
          if (!original) return;
          if (original.value !== null && "value" in node) (node as HTMLInputElement).value = original.value;
          if (original.text !== null && node instanceof HTMLElement && node.isContentEditable) node.textContent = original.text;
        });
      }, originals);
    }
    let omittedNodes = 0;
    if (interactive) {
      const filtered = filterInteractiveYaml(yaml);
      yaml = filtered.yaml;
      omittedNodes = filtered.omittedNodes;
    }
    if (params.depth != null && params.depth > 0) {
      yaml = yaml
        .split("\n")
        .filter((ln) => (ln.match(/^\s*/)?.[0].length ?? 0) / 2 <= params.depth!)
        .join("\n");
    }
    yaml = redactSnapshotYaml(yaml);
    // Name the kinds, not just the count: an OTP-only page reported as a
    // password field told the person "it thinks this is a password box" on a
    // 2-step verification screen.
    if (secrets.length > 0) {
      const kinds = [...new Set(secrets.map((field) => field.kind))].join(",");
      let prefix = `modelbot_sensitive_fields: ${secrets.length} ${kinds}\n`;
      const detail = await page.evaluate(() =>
        document.getElementById("modelbot-secret-mask")?.getAttribute("data-modelbot-detail") ?? "",
      ).catch(() => "");
      if (detail) prefix += `modelbot_sensitive_detail: ${detail}\n`;
      yaml = `${prefix}${yaml}`;
    }
    let omittedChars = 0;
    if (yaml.length > maxChars) {
      omittedChars = yaml.length - maxChars;
      yaml = yaml.slice(0, maxChars);
    }
    const truncated = omittedNodes > 0 || omittedChars > 0;

    const refs = [...yaml.matchAll(/\[ref=(e\d+)\]/g)].map((m) => m[1]!);
    const bindings = new Map<string, { role: string; name: string; nth: number }>();
    const counts = new Map<string, number>();
    for (const line of yaml.split("\n")) {
      const m = line.match(/^\s*-\s*(\w+)(?:\s+"([^"]*)")?.*\[ref=(e\d+)\]/);
      if (!m) continue;
      const role = m[1]!;
      const name = m[2] ?? "";
      const ref = m[3]!;
      const key = `${role}\0${name}`;
      const nth = counts.get(key) ?? 0;
      counts.set(key, nth + 1);
      bindings.set(ref, { role, name, nth });
    }
    const id = `snap_${randomBytes(6).toString("hex")}`;
    this.snaps.set(id, { id, refs: new Set(refs), bindings, page });

    return {
      ok: true,
      data: {
        snapshot_id: id,
        yaml,
        truncated,
        refs,
        url: redactUrl(page.url()),
        title: redactUrl(await page.title()),
        ...(truncated ? { omitted: { nodes: omittedNodes, chars: omittedChars } } : {}),
      },
    };
    });
  }

  private async staleRefError(): Promise<ToolResult> {
    const details: Record<string, unknown> = { retry: "browser_snapshot", url: "", title: "" };
    const page = this.page;
    if (page && !page.isClosed()) {
      try {
        const snap = await this.snapshot({
          scope: null,
          interactive_only: true,
          depth: null,
          max_chars: null,
        });
        if (snap.ok) Object.assign(details, snap.data);
      } catch {
        /* url/title fallback below */
      }
      if (typeof details.url !== "string" || details.url === "") {
        try {
          details.url = redactUrl(page.url());
        } catch {
          details.url = "";
        }
      }
      if (typeof details.title !== "string" || details.title === "") {
        try {
          details.title = redactUrl(await page.title());
        } catch {
          details.title = "";
        }
      }
    }
    return toolError(
      "E_STALE_REF",
      "The page changed — take a new snapshot and continue.",
      details,
    );
  }

  private async resolveRef(
    snapshotId: string,
    ref: string,
  ): Promise<{ ok: true; locator: ReturnType<Page["locator"]> } | ToolResult> {
    const snap = this.snaps.get(snapshotId);
    const target = snap?.page ?? this.requirePage();
    const r = await resolveSnapRef(this.snaps, target, snapshotId, ref);
    if (!("locator" in r)) return this.staleRefError();
    try {
      if ((await r.locator.count()) === 0) return this.staleRefError();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      if (
        isStaleLocatorError(err) ||
        RESOLVE_TEARDOWN.test(errorText(err)) ||
        TARGET_CLOSED.test(errorText(err))
      ) {
        return this.staleRefError();
      }
      throw err;
    }
    return r;
  }

  async click(p: {
    snapshot_id: string;
    ref: string;
    button: string | null;
    double_click: boolean | null;
  }): Promise<ToolResult> {
    return recoverActResult(this, async () => {
    const r = await this.resolveRef(p.snapshot_id, p.ref);
    if (!("locator" in r)) return r;
    const button = (p.button as "left") ?? "left";
    const page = this.snaps.get(p.snapshot_id)?.page ?? this.requirePage();
    // noWaitAfter: download links never navigate; Playwright would hang waiting.
    // Race a short download window so ordinary clicks stay fast.
    // Waiter must be armed before click. Short race keeps ordinary clicks fast;
    // page.on("download") still quarantines if the attachment is slow.
    // Resolve already decided stale. Act-path throws stay E_IO (action may have run).
    try {
      const dlWait = page
        .waitForEvent("download", { timeout: 8_000 })
        .then((dl) => this.quarantineDownloadOnce(dl))
        .catch(() => null);
      const act = { button, noWaitAfter: true };
      if (p.double_click) {
        await this.runAct(() => r.locator.dblclick(act));
      } else {
        await this.runAct(() => r.locator.click(act));
      }
      const downloaded = await Promise.race([
        dlWait,
        sleep(2_500).then(() => null),
      ]);
      return {
        ok: true,
        data: downloaded
          ? { clicked: p.ref, download: downloaded }
          : { clicked: p.ref },
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      if (isCrashedTarget(err, this.page)) throw err;
      if (TARGET_CLOSED.test(errorText(err))) return this.staleRefError();
      return toolError("E_IO", err instanceof Error ? err.message : String(err));
    }
    });
  }

  async type(p: {
    snapshot_id: string;
    ref: string;
    text: string;
    submit: boolean | null;
    slowly: boolean | null;
  }): Promise<ToolResult> {
    return recoverActResult(this, async () => {
    const r = await this.resolveRef(p.snapshot_id, p.ref);
    if (!("locator" in r)) return r;
    try {
      if (p.slowly) {
        await this.runAct(() => r.locator.pressSequentially(p.text, { delay: 20 }));
      } else {
        await this.runAct(() => r.locator.fill(p.text));
      }
      if (p.submit) {
        await this.runAct(() => r.locator.press("Enter"));
      }
      return { ok: true, data: { typed: p.text.length, ref: p.ref } };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      if (isCrashedTarget(err, this.page)) throw err;
      if (TARGET_CLOSED.test(errorText(err))) return this.staleRefError();
      return toolError("E_IO", err instanceof Error ? err.message : String(err));
    }
    });
  }

  async press(p: {
    key: string;
    snapshot_id: string | null;
    ref: string | null;
  }): Promise<ToolResult> {
    const page = this.requirePage();
    if (p.snapshot_id && p.ref) {
      const r = await this.resolveRef(p.snapshot_id, p.ref);
      if (!("locator" in r)) return r;
      await r.locator.press(p.key);
    } else await page.keyboard.press(p.key);
    return { ok: true, data: { pressed: p.key } };
  }

  async scroll(p: {
    snapshot_id: string | null;
    ref: string | null;
    dx: number | null;
    dy: number | null;
    direction: string | null;
    amount: number | null;
  }): Promise<ToolResult> {
    const page = this.requirePage();
    const amt = p.amount ?? 400;
    let dx = p.dx ?? 0;
    let dy = p.dy ?? 0;
    if (p.direction === "down") dy = amt;
    if (p.direction === "up") dy = -amt;
    if (p.direction === "right") dx = amt;
    if (p.direction === "left") dx = -amt;
    if (p.snapshot_id && p.ref) {
      const r = await this.resolveRef(p.snapshot_id, p.ref);
      if (!("locator" in r)) return r;
      await r.locator.scrollIntoViewIfNeeded();
    }
    await page.mouse.wheel(dx, dy);
    return { ok: true, data: { scrolled: true, dx, dy } };
  }

  async select(p: {
    snapshot_id: string;
    ref: string;
    values: string[];
  }): Promise<ToolResult> {
    const r = await this.resolveRef(p.snapshot_id, p.ref);
    if (!("locator" in r)) return r;
    await r.locator.selectOption(p.values);
    return { ok: true, data: { selected: p.values } };
  }

  async upload(p: {
    snapshot_id: string;
    ref: string;
    paths: string[];
  }): Promise<ToolResult> {
    const r = await this.resolveRef(p.snapshot_id, p.ref);
    if (!("locator" in r)) return r;
    const abs: string[] = [];
    for (const path of p.paths) {
      const j = jailPath(path);
      if (!("abs" in j)) return j;
      abs.push(j.abs);
    }
    await r.locator.setInputFiles(abs);
    return { ok: true, data: { uploaded: abs.length } };
  }

  async tabs(p: {
    action: string;
    tab_id: string | null;
    url: string | null;
  }): Promise<ToolResult> {
    const ctx = this.context!;
    if (p.action === "list") {
      return {
        ok: true,
        data: {
          tabs: ctx.pages().map((pg, i) => ({
            tab_id: `t${i}`,
            url: redactUrl(pg.url()),
            active: pg === this.page,
          })),
        },
      };
    }
    if (p.action === "new") {
      const open = ctx.pages().filter((pg) => !pg.isClosed()).length;
      if (open >= MAX_TABS) {
        return toolError(
          "E_POLICY",
          `max_tabs ${MAX_TABS}; close a tab that is no longer needed`,
        );
      }
      if (p.url) {
        let parsed: URL;
        try {
          parsed = new URL(p.url);
        } catch {
          return toolError("E_POLICY", "invalid navigation URL");
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return toolError("E_POLICY", `navigation scheme not allowed: ${parsed.protocol}`);
        }
      }
      const pg = await ctx.newPage();
      await this.navigation.attach(ctx, pg);
      if (p.url) {
        await pg.goto(p.url);
      }
      this.page = pg;
      this.livePage = pg;
      await this.attachCdp(pg);
      return { ok: true, data: { tab_id: `t${ctx.pages().length - 1}` } };
    }
    if (p.action === "select" && p.tab_id) {
      const idx = Number(String(p.tab_id).replace(/^t/, ""));
      const pg = ctx.pages()[idx];
      if (!pg) return toolError("E_IO", "unknown tab");
      this.page = pg;
      this.livePage = pg;
      await pg.bringToFront();
      await this.attachCdp(pg);
      return { ok: true, data: { tab_id: p.tab_id } };
    }
    if (p.action === "close") {
      const idx = p.tab_id
        ? Number(String(p.tab_id).replace(/^t/, ""))
        : ctx.pages().indexOf(this.page!);
      const pg = ctx.pages()[idx];
      if (!pg) return toolError("E_IO", "unknown tab");
      await pg.close();
      this.page = chooseLivePage(ctx.pages()) ?? null;
      this.livePage = this.page;
      if (this.page) await this.attachCdp(this.page);
      return { ok: true, data: { closed: true } };
    }
    return toolError("E_IO", "invalid tabs action");
  }

  async screenshot(p: {
    full_page: boolean | null;
    max_width: number | null;
    max_height: number | null;
    snapshot_id: string | null;
    ref: string | null;
  }): Promise<ToolResult<BrowserScreenshotOutput>> {
    const page = this.requirePage();
    await this.maskSecrets();
    const style = `${SECRET_MASK_SELECTORS}{filter:blur(8px)!important;background:#111!important;color:transparent!important}`;
    const masks = page.locator(SECRET_MASK_SELECTORS);
    let buf: Buffer;
    if (p.snapshot_id && p.ref) {
      const r = await this.resolveRef(p.snapshot_id, p.ref);
      if (!("locator" in r)) return r as ToolResult<BrowserScreenshotOutput>;
      const maskCount = await masks.count();
      buf = await withFontLoadRetry(() => r.locator.screenshot({
        type: "jpeg",
        quality: JPEG_Q,
        style,
        mask: maskCount > 0 ? [masks] : undefined,
      }));
    } else {
      const maskCount = await masks.count();
      buf = await withFontLoadRetry(() => page.screenshot({
        type: "jpeg",
        quality: JPEG_Q,
        fullPage: !!p.full_page,
        scale: "css",
        style,
        mask: maskCount > 0 ? [masks] : undefined,
      }));
    }
    const vp = page.viewportSize() ?? VIEWPORT;
    const scroll = await page.evaluate(() => ({
      x: window.scrollX,
      y: window.scrollY,
    }));
    const dim = jpegSize(buf) ?? { width: vp.width, height: vp.height };
    const image_id = `img_${randomBytes(6).toString("hex")}`;
    return {
      ok: true,
      data: {
        image_id,
        mime: "image/jpeg",
        width: dim.width,
        height: dim.height,
        css_width: vp.width,
        css_height: vp.height,
        scale: dim.width / vp.width,
        scroll_x: scroll.x,
        scroll_y: scroll.y,
      },
    };
  }

  async wait(p: {
    timeout_ms: number | null;
    ms: number | null;
    text: string | null;
    url_glob: string | null;
    load_state: string | null;
  }): Promise<ToolResult> {
    const page = this.requirePage();
    const timeout = p.timeout_ms ?? 30_000;
    if (p.ms != null) await page.waitForTimeout(p.ms);
    else if (p.text) await page.getByText(p.text).first().waitFor({ timeout });
    else if (p.url_glob) await page.waitForURL(p.url_glob, { timeout });
    else if (p.load_state)
      await page.waitForLoadState(p.load_state as "load", { timeout });
    else await page.waitForTimeout(100);
    return { ok: true, data: { waited: true } };
  }

  async mouse(p: {
    action: string;
    x: number;
    y: number;
    x2: number | null;
    y2: number | null;
    button: number | null;
    dx: number | null;
    dy: number | null;
  }): Promise<ToolResult> {
    if (this.desktop && this.liveMode === "human") {
      await this.desktop.pointer(p);
      return { ok: true, data: { action: p.action } };
    }
    // Agent and HUMAN input stay on the ACTION/request page; livePage is view-only.
    // raw CDP mouse events do not focus inputs in headless Chromium.
    const page = this.liveMode === "human" ? this.liveTarget() : this.requirePage();
    if (!page) return toolError("E_IO", "takeover target unavailable");
    const vp = page.viewportSize() ?? VIEWPORT;
    const x = Math.max(0, Math.min(vp.width, p.x));
    const y = Math.max(0, Math.min(vp.height, p.y));
    const button = p.button === 1 ? "middle" : p.button === 2 ? "right" : "left";
    if (this.liveMode === "human" && (p.action === "down" || p.action === "click")) {
      await page.bringToFront();
    }
    if (p.action === "move") await page.mouse.move(x, y);
    else if (p.action === "click") await page.mouse.click(x, y, { button });
    else if (p.action === "dblclick") await page.mouse.dblclick(x, y, { button });
    else if (p.action === "down") {
      await page.mouse.move(x, y);
      await page.mouse.down({ button });
    } else if (p.action === "up") await page.mouse.up({ button });
    else if (p.action === "drag" && p.x2 != null && p.y2 != null) {
      const x2 = Math.max(0, Math.min(vp.width, p.x2));
      const y2 = Math.max(0, Math.min(vp.height, p.y2));
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x2, y2);
      await page.mouse.up();
    } else if (p.action === "wheel") {
      await page.mouse.wheel(p.dx ?? 0, p.dy ?? 0);
    }
    return { ok: true, data: { action: p.action, x, y } };
  }

  async key(p: { key: string; mods: number | null }): Promise<ToolResult> {
    await this.resetLiveKeys();
    await this.requirePage().keyboard.press(keyChord(p.key, p.mods));
    return { ok: true, data: { key: p.key } };
  }

  async resetLiveKeys(): Promise<void> {
    await this.desktop?.reset();
    await this.liveKeyboard?.relay.reset();
  }

  /** HUMAN operator input stays bound to the takeover target. */
  async liveKey(p: RelayKey): Promise<ToolResult> {
    if (this.desktop && this.liveMode === "human") {
      await this.desktop.key(p);
      return { ok: true, data: { key: p.key } };
    }
    const page = this.liveTarget();
    if (!page) return toolError("E_IO", "takeover target unavailable");
    await page.bringToFront();
    if (this.liveKeyboard?.page !== page) {
      await this.resetLiveKeys();
      this.liveKeyboard = { page, relay: new KeyboardRelay(page.keyboard) };
    }
    await this.liveKeyboard.relay.send(p);
    return { ok: true, data: { key: p.key } };
  }

  async typeText(p: { text: string }): Promise<ToolResult> {
    if (this.desktop && this.liveMode === "human") {
      await this.desktop.text(p.text);
      return { ok: true, data: { typed: p.text.length } };
    }
    const page = this.liveMode === "human" ? this.liveTarget() : this.requirePage();
    if (!page) return toolError("E_IO", "takeover target unavailable");
    if (this.liveMode === "human") await page.bringToFront();
    await page.keyboard.insertText(p.text);
    return { ok: true, data: { typed: p.text.length } };
  }
}

function sniffMime(bytes: Uint8Array, basename: string): string {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return "application/pdf";
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (basename.toLowerCase().endsWith(".csv")) return "text/csv";
  const sample = Buffer.from(bytes.subarray(0, 4096));
  return sample.includes(0) ? "application/octet-stream" : "text/plain";
}

function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

export async function chromiumAvailable(): Promise<boolean> {
  try {
    const b: Browser = await chromium.launch({ headless: true });
    await b.close();
    return true;
  } catch {
    return false;
  }
}
