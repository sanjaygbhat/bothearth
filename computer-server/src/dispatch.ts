import type {
  ComputerJsonRpcRequest,
  ScreencastFrameHeader,
  ToolResult,
} from "../../src/types/contracts.ts";
import { TOOL_NAMES } from "../../src/types/contracts.ts";
import { toolError } from "../../src/protocol/errors.ts";
import { redactUrl } from "./redact.ts";
import type { BrowserSession } from "./browser/session.ts";
import {
  filesDelete,
  filesList,
  filesRead,
  filesWrite,
  shellExec,
} from "./shell/tools.ts";
import { writeFile } from "./out-files.ts";
import { applyTakeoverTransition } from "../../src/protocol/takeover.ts";
import {
  createTakeoverSession,
  gateMethod,
  statusPayload,
  transition,
  type TakeoverSession,
} from "./takeover-gate.ts";

export type Role = "browser" | "shell";

export interface ServerState {
  role: Role;
  browser: BrowserSession | null;
  /** Why the last launch attempt failed, so a takeover is not offered instead. */
  browserError: string | null;
  takeover: TakeoverSession;
  screencastSubscribed: boolean;
  onLiveFrame: ((h: ScreencastFrameHeader, jpeg: Uint8Array) => void) | null;
}

export function createState(role: Role): ServerState {
  return {
    role,
    browser: null,
    browserError: null,
    takeover: createTakeoverSession(),
    screencastSubscribed: false,
    onLiveFrame: null,
  };
}

/**
 * Nothing the model or a human at the live view can do about a browser that
 * will not start. Say that, so it does not read as a page error and turn into a
 * takeover request onto a blank canvas.
 */
function browserUnavailable(detail: string): Error {
  return Object.assign(
    new Error(
      `The browser cannot start, so no page can be loaded, shown or driven. Taking control would show an empty screen; report the failure instead. ${detail}`,
    ),
    { code: "E_SANDBOX_DEAD" },
  );
}

async function browser(state: ServerState, origins?: string[], allowPublicNavigation = false): Promise<BrowserSession> {
  if (state.role !== "browser") {
    throw Object.assign(new Error("browser role required"), { code: "E_CAPABILITY" });
  }
  if (!state.browser) {
    // Dynamic import: the shell image has no playwright, and a static import
    // would crash stdio bootstrap before takeover.sync / shell_exec can run.
    const { BrowserSession } = await import("./browser/session.ts");
    const session = new BrowserSession();
    if (origins) session.setNavigationPolicy(origins, allowPublicNavigation);
    try {
      await session.start();
    } catch (err) {
      await session.close().catch(() => undefined);
      state.browserError = err instanceof Error ? err.message : String(err);
      throw browserUnavailable(state.browserError);
    }
    state.browser = session;
    state.browserError = null;
    state.browser.onLiveFrame = (h, jpeg) => {
      if (state.screencastSubscribed) state.onLiveFrame?.(h, jpeg);
    };
  }
  if (origins) state.browser.setNavigationPolicy(origins, allowPublicNavigation);
  return state.browser;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function s(v: unknown, d = ""): string {
  return typeof v === "string" ? v : d;
}
function sn(v: unknown): string | null {
  return v == null ? null : String(v);
}
function nn(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function bn(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : v == null ? null : Boolean(v);
}

/** Same bind as decline: a provided id cannot address a different active session. */
function takeoverIdMismatch(session: TakeoverSession, id: string): boolean {
  return Boolean(id && session.takeoverId && id !== session.takeoverId);
}

/**
 * Every method `dispatch` answers, in switch order.
 *
 * The daemon once offered the model `write_file` while the computer it was
 * talking to had never heard of it, and the only way anyone found out was a
 * failed task. The daemon now asks for this list on attach and advertises the
 * intersection, so a computer built before a tool shipped simply does not offer
 * it. `tests/unit/computer-server/methods.test.ts` asserts this list and the
 * switch below cannot drift apart.
 */
export const SUPPORTED_METHODS: readonly string[] = [
  "policy.call",
  "takeover.sync",
  "takeover.masked-observation",
  "screencast.subscribe",
  "screencast.unsubscribe",
  "takeover.grant",
  "takeover.release",
  "takeover.decline",
  "takeover.validate",
  "takeover.ttl",
  "live.pointer",
  "live.key",
  "live.text",
  "quarantine.list",
  "quarantine.promote",
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_scroll",
  "browser_select",
  "browser_upload",
  "browser_tabs",
  "browser_screenshot",
  "browser_wait",
  "computer_mouse",
  "computer_key",
  "computer_type",
  "shell_exec",
  "files_list",
  "files_read",
  "files_write",
  "files_delete",
  "write_file",
  "takeover.request",
  "request_takeover",
  "takeover_status",
  "done",
  "connector_call",
  "methods",
] as const;

export async function dispatch(
  state: ServerState,
  req: ComputerJsonRpcRequest,
): Promise<ToolResult> {
  const method = req.method;
  const p = obj(req.params);

  const blocked = gateMethod(state.takeover, method, nn(p.epoch));
  if (blocked) return blocked;

  try {
    switch (method) {
      case "policy.call": {
        const target = s(p.method);
        if (!(TOOL_NAMES as readonly string[]).includes(target) ||
            !(target.startsWith("browser_") || target.startsWith("computer_")) ||
            !Array.isArray(p.navigation_origins) ||
            !p.navigation_origins.every((origin) => typeof origin === "string") ||
            (p.allow_public_navigation !== undefined && typeof p.allow_public_navigation !== "boolean")) {
          return toolError("E_POLICY", "invalid navigation policy envelope");
        }
        // Serialized by rpc-loop: no other task can replace the policy between set and act.
        const b = await browser(state, p.navigation_origins as string[], p.allow_public_navigation === true);
        const before = b.consumeNavigationDenied();
        if (before) return toolError("E_POLICY", before.reason, { navigation_url: redactUrl(before.url), ...(before.initial_popup ? { initial_popup: true } : {}) });
        const result = await dispatch(state, { ...req, method: target, params: p.params })
          .catch((error: unknown) => toolError("E_IO", error instanceof Error ? error.message : String(error)));
        const denied = b.consumeNavigationDenied();
        return denied ? toolError("E_POLICY", denied.reason, { navigation_url: redactUrl(denied.url), ...(denied.initial_popup ? { initial_popup: true } : {}) }) : result;
      }
      case "takeover.sync": {
        state.takeover.takeoverId = s(p.takeover_id);
        state.takeover.expiresAt = s(p.expires_at);
        state.takeover.state = "takeover_requested";
        state.takeover.epoch += 1;
        return { ok: true, data: statusPayload(state.takeover) };
      }
      case "takeover.masked-observation": {
        const b = await browser(state);
        const sensitive = await b.maskSecrets();
        return { ok: true, data: { still_sensitive: sensitive.length > 0 } };
      }
      case "screencast.subscribe": {
        const b = await browser(state);
        state.screencastSubscribed = true;
        await b.startScreencast();
        return { ok: true, data: { subscribed: true, fps: 2 } };
      }
      case "screencast.unsubscribe": {
        state.screencastSubscribed = false;
        await state.browser?.resetLiveKeys();
        await state.browser?.stopScreencast();
        return { ok: true, data: { subscribed: false } };
      }
      case "takeover.grant": {
        const id = s(p.takeover_id);
        if (takeoverIdMismatch(state.takeover, id)) {
          return toolError("E_POLICY", "invalid takeover grant");
        }
        if (!applyTakeoverTransition(state.takeover.state, "grant")) {
          return toolError("E_POLICY", "invalid takeover grant");
        }
        // An early grant must initialize the browser before switching its mode.
        // Otherwise the later viewer starts an agent stream during HUMAN control.
        if (state.role === "browser") await browser(state);
        // Stop the old stream BEFORE switching control. Playwright 1.59 cannot
        // cancel a locator action (`{signal}` is dropped), so refuse new acts
        // immediately and await in-flight click/type before the grant ack.
        // Side effects only after the transition is accepted.
        const drained = state.browser?.abortActs();
        const operatorLive = state.screencastSubscribed;
        await state.browser?.stopScreencast();
        state.screencastSubscribed = false;
        await drained;
        state.browser?.setLiveMode("human", true);
        transition(state.takeover, "grant");
        // Only the authenticated operator receives live frames; model RPCs remain blocked.
        state.screencastSubscribed = operatorLive;
        if (operatorLive) await state.browser?.startScreencast();
        return { ok: true, data: statusPayload(state.takeover) };
      }
      case "takeover.release": {
        const id = s(p.takeover_id);
        if (takeoverIdMismatch(state.takeover, id)) {
          return toolError("E_POLICY", "invalid takeover release");
        }
        if (!transition(state.takeover, "release")) {
          return toolError("E_POLICY", "invalid takeover release");
        }
        await state.browser?.resetLiveKeys();
        state.browser?.setLiveMode("validating", true);
        return { ok: true, data: statusPayload(state.takeover) };
      }
      case "takeover.decline": {
        const id = s(p.takeover_id);
        if (takeoverIdMismatch(state.takeover, id)) {
          return toolError("E_POLICY", "invalid takeover decline");
        }
        // The shell never saw request_takeover, so already being agent is the
        // destination: decline is a no-op success rather than E_POLICY.
        if (state.takeover.state === "agent") {
          return { ok: true, data: statusPayload(state.takeover) };
        }
        if (!transition(state.takeover, "decline")) {
          return toolError("E_POLICY", "invalid takeover decline");
        }
        state.browser?.setLiveMode("agent", true);
        if (state.screencastSubscribed) await state.browser?.startScreencast();
        return { ok: true, data: statusPayload(state.takeover) };
      }
      case "takeover.validate": {
        const still = Boolean(p.still_sensitive);
        const next = transition(
          state.takeover,
          still ? "still_sensitive" : "validated",
        );
        if (!next) return toolError("E_POLICY", "invalid takeover validate");
        if (next === "agent") state.browser?.setLiveMode("agent", true);
        if (next === "human") state.browser?.setLiveMode("human", true);
        return { ok: true, data: statusPayload(state.takeover) };
      }
      case "takeover.ttl": {
        const id = s(p.takeover_id);
        if (takeoverIdMismatch(state.takeover, id)) {
          return toolError("E_POLICY", "invalid takeover ttl");
        }
        if (!transition(state.takeover, "ttl")) {
          return toolError("E_POLICY", "invalid takeover ttl");
        }
        await state.browser?.resetLiveKeys();
        await state.browser?.stopScreencast();
        return { ok: true, data: statusPayload(state.takeover) };
      }
      case "live.pointer": {
        const kind = s(p.kind, "move");
        if (
          kind !== "move" &&
          kind !== "down" &&
          kind !== "up" &&
          kind !== "wheel"
        ) {
          return toolError("E_IO", "invalid live.pointer kind");
        }
        const b = await browser(state);
        return b.mouse({
          action:
            kind === "down"
              ? "down"
              : kind === "up"
                ? "up"
                : kind === "wheel"
                  ? "wheel"
                  : "move",
          x: Number(p.x ?? 0),
          y: Number(p.y ?? 0),
          x2: null,
          y2: null,
          button: nn(p.button),
          dx: nn(p.deltaX),
          dy: nn(p.deltaY),
        });
      }
      case "live.key": {
        const b = await browser(state);
        return b.liveKey({ key: s(p.key), code: sn(p.code), mods: nn(p.mods), kind: sn(p.kind) });
      }
      case "live.text": {
        const b = await browser(state);
        return b.typeText({ text: s(p.text) });
      }
      case "quarantine.list": {
        const b = await browser(state);
        return b.listQuarantine();
      }
      case "quarantine.promote": {
        const b = await browser(state);
        return b.promoteQuarantine(s(p.id));
      }

      case "browser_navigate": {
        const b = await browser(state);
        return b.navigate(s(p.url), sn(p.wait_until));
      }
      case "browser_snapshot": {
        const b = await browser(state);
        return b.snapshot({
          scope: sn(p.scope),
          interactive_only: bn(p.interactive_only),
          depth: nn(p.depth),
          max_chars: nn(p.max_chars),
        });
      }
      case "browser_click": {
        const b = await browser(state);
        return b.click({
          snapshot_id: s(p.snapshot_id),
          ref: s(p.ref),
          button: sn(p.button),
          double_click: bn(p.double_click),
        });
      }
      case "browser_type": {
        const b = await browser(state);
        return b.type({
          snapshot_id: s(p.snapshot_id),
          ref: s(p.ref),
          text: s(p.text),
          submit: bn(p.submit),
          slowly: bn(p.slowly),
        });
      }
      case "browser_press": {
        const b = await browser(state);
        return b.press({
          key: s(p.key),
          snapshot_id: sn(p.snapshot_id),
          ref: sn(p.ref),
        });
      }
      case "browser_scroll": {
        const b = await browser(state);
        return b.scroll({
          snapshot_id: sn(p.snapshot_id),
          ref: sn(p.ref),
          dx: nn(p.dx),
          dy: nn(p.dy),
          direction: sn(p.direction),
          amount: nn(p.amount),
        });
      }
      case "browser_select": {
        const b = await browser(state);
        return b.select({
          snapshot_id: s(p.snapshot_id),
          ref: s(p.ref),
          values: Array.isArray(p.values) ? p.values.map(String) : [],
        });
      }
      case "browser_upload": {
        const b = await browser(state);
        return b.upload({
          snapshot_id: s(p.snapshot_id),
          ref: s(p.ref),
          paths: Array.isArray(p.paths) ? p.paths.map(String) : [],
        });
      }
      case "browser_tabs": {
        const b = await browser(state);
        return b.tabs({
          action: s(p.action),
          tab_id: sn(p.tab_id),
          url: sn(p.url),
        });
      }
      case "browser_screenshot": {
        const b = await browser(state);
        return b.screenshot({
          full_page: bn(p.full_page),
          max_width: nn(p.max_width),
          max_height: nn(p.max_height),
          snapshot_id: sn(p.snapshot_id),
          ref: sn(p.ref),
        });
      }
      case "browser_wait": {
        const b = await browser(state);
        return b.wait({
          timeout_ms: nn(p.timeout_ms),
          ms: nn(p.ms),
          text: sn(p.text),
          url_glob: sn(p.url_glob),
          load_state: sn(p.load_state),
        });
      }
      case "computer_mouse": {
        const b = await browser(state);
        return b.mouse({
          action: s(p.action),
          x: Number(p.x ?? 0),
          y: Number(p.y ?? 0),
          x2: nn(p.x2),
          y2: nn(p.y2),
          button: nn(p.button),
          dx: nn(p.dx),
          dy: nn(p.dy),
        });
      }
      case "computer_key": {
        const b = await browser(state);
        return b.key({ key: s(p.key), mods: nn(p.mods) });
      }
      case "computer_type": {
        const b = await browser(state);
        return b.typeText({ text: s(p.text) });
      }

      case "shell_exec": {
        if (state.role !== "shell") {
          return toolError("E_CAPABILITY", "shell role required");
        }
        return shellExec({
          command: s(p.command),
          cwd: sn(p.cwd),
          timeout_ms: nn(p.timeout_ms),
        });
      }
      case "files_list":
        return filesList({ path: s(p.path) });
      case "files_read":
        return filesRead({
          path: s(p.path),
          offset: nn(p.offset),
          limit: nn(p.limit),
        });
      case "files_write":
        return filesWrite({
          path: s(p.path),
          content: s(p.content),
          mkdir: bn(p.mkdir),
        });
      case "files_delete":
        return filesDelete({ path: s(p.path) });
      // Not role-gated and not under the shell capability: saving a deliverable
      // into /workspace/out is what a browser-only computer needs most.
      case "write_file":
        return writeFile({
          path: s(p.path),
          content: s(p.content),
          encoding: sn(p.encoding) as "utf8" | "base64" | null,
          mode: sn(p.mode) as "create" | "overwrite" | "append" | null,
        });

      case "takeover.request":
      case "request_takeover": {
        // A takeover on a browser that could not start hands the human a blank
        // canvas and parks the task in needs-you forever. Repeat the launch
        // failure instead of asking for help nobody can give.
        if (state.browserError) throw browserUnavailable(state.browserError);
        if (!transition(state.takeover, "request")) {
          return toolError("E_POLICY", "cannot request takeover");
        }
        state.takeover.reason = s(p.reason) || null;
        // The page, not the caller, decides whether a credential field is on
        // screen: a person answering "there is a code to type in" needs to be
        // told which box, and an ask with no field behind it is a wrong ask.
        state.takeover.field = (await state.browser?.maskSecrets())?.[0] ?? null;
        return { ok: true, data: statusPayload(state.takeover) };
      }
      case "takeover_status":
        return { ok: true, data: statusPayload(state.takeover) };
      case "done":
        return {
          ok: true,
          data: { summary: s(p.summary), status: p.status ?? "success" },
        };
      case "connector_call":
        return toolError("E_CAPABILITY", "connector_call is host-side");
      // What this build can actually do. Answered before any role check so a
      // shell-only computer reports the same list a browser one does; the
      // daemon's own capability gate decides which of them a task may use.
      case "methods":
        return { ok: true, data: { methods: [...SUPPORTED_METHODS] } };
      default:
        return toolError("E_CAPABILITY", `unknown method: ${method}`);
    }
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === "E_CAPABILITY" || err.code === "E_IO" || err.code === "E_SANDBOX_DEAD") {
      return toolError(err.code, err.message);
    }
    return toolError("E_IO", err.message || "internal error");
  }
}
