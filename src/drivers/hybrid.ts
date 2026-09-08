import type {
  Driver,
  DriverObserveResult,
  LadderRung,
  McpToolDescriptor,
  ToolResult,
} from "../types/contracts.ts";
import { TOOL_CATALOGUE } from "../tools/catalog.ts";
import {
  A11Y_TOOLS,
  isTargetFailure,
  observationHash,
  resolveDriverTransport,
  toolTarget,
  type DriverToolResultNotice,
  type DriverTransportResolver,
} from "./a11y.ts";
import { VISION_TOOLS } from "./vision.ts";

export const HYBRID_TOOLS: readonly McpToolDescriptor[] = TOOL_CATALOGUE.map(
  (tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }),
);

export interface HybridDriverOptions {
  snapshotMaxChars?: number;
  screenshotMaxWidth?: number;
  screenshotMaxHeight?: number;
}

interface HybridState {
  rung: LadderRung;
  lastTarget: string | null;
  failureTarget: string | null;
  consecutiveFailures: number;
  unchangedFailures: number;
  lastObservationHash: string | null;
  snapshotId: string | null;
  emptyTargetRef: string | null;
}

function initialState(): HybridState {
  return {
    rung: "A11Y_FULL",
    lastTarget: null,
    failureTarget: null,
    consecutiveFailures: 0,
    unchangedFailures: 0,
    lastObservationHash: null,
    snapshotId: null,
    emptyTargetRef: null,
  };
}

export class HybridDriver implements Driver {
  readonly kind = "hybrid" as const;
  readonly tools: readonly McpToolDescriptor[] = HYBRID_TOOLS;
  private readonly resolver: DriverTransportResolver;
  private readonly opts: HybridDriverOptions;
  private readonly states = new Map<string, HybridState>();

  constructor(resolver: DriverTransportResolver, opts: HybridDriverOptions = {}) {
    this.resolver = resolver;
    this.opts = opts;
  }

  getRung(computerId: string): LadderRung {
    return this.state(computerId).rung;
  }

  toolsFor(computerId: string): readonly McpToolDescriptor[] {
    const rung = this.getRung(computerId);
    if (rung === "VISION_COORDS") return VISION_TOOLS;
    if (rung === "ELEMENT_SHOT") {
      const screenshot = HYBRID_TOOLS.find((tool) => tool.name === "browser_screenshot");
      return screenshot ? [...A11Y_TOOLS, screenshot] : A11Y_TOOLS;
    }
    return A11Y_TOOLS;
  }

  async observe(computerId: string): Promise<DriverObserveResult> {
    const state = this.state(computerId);
    const transport = resolveDriverTransport(this.resolver, computerId);
    let result: ToolResult;
    if (state.rung === "TAKEOVER") {
      result = await transport.call("request_takeover", {
        reason: "The browser fallback ladder requires human control.",
        category: "other",
      });
    } else if (state.rung === "VISION_COORDS") {
      result = await transport.call("browser_screenshot", {
        full_page: false,
        max_width: this.opts.screenshotMaxWidth ?? null,
        max_height: this.opts.screenshotMaxHeight ?? null,
        snapshot_id: null,
        ref: null,
      });
    } else if (state.rung === "ELEMENT_SHOT") {
      result = await transport.call("browser_screenshot", {
        full_page: false,
        max_width: this.opts.screenshotMaxWidth ?? null,
        max_height: this.opts.screenshotMaxHeight ?? null,
        snapshot_id: state.snapshotId,
        ref: state.emptyTargetRef ?? refFromTarget(state.lastTarget),
      });
    } else {
      const scoped = state.rung === "A11Y_SCOPED";
      result = await transport.call("browser_snapshot", {
        scope: scoped ? refFromTarget(state.lastTarget) : null,
        interactive_only: true,
        depth: scoped ? 6 : null,
        max_chars: scoped
          ? Math.min(this.opts.snapshotMaxChars ?? 16_000, 8_000)
          : (this.opts.snapshotMaxChars ?? 16_000),
      });
      this.inspectSnapshot(state, result);
    }
    const hash = observationHash(result);
    state.lastObservationHash = hash;
    return { rung: state.rung, observation: result, observation_hash: hash };
  }

  recordToolResult(computerId: string, notice: DriverToolResultNotice): void {
    const state = this.state(computerId);
    const target = toolTarget(notice.arguments);
    if (target) state.lastTarget = target;
    if (notice.result.ok) {
      state.failureTarget = null;
      state.consecutiveFailures = 0;
      state.unchangedFailures = 0;
      return;
    }
    if (!isTargetFailure(notice.result)) return;
    if (target && target === state.failureTarget) state.consecutiveFailures += 1;
    else {
      state.failureTarget = target;
      state.consecutiveFailures = 1;
    }
    const unchanged =
      notice.observationHash !== undefined &&
      notice.observationHash === state.lastObservationHash;
    state.unchangedFailures = unchanged ? state.unchangedFailures + 1 : 0;

    // A first stale ref only invalidates refs and re-snapshots; refs go stale as
    // ordinary loop behaviour, so escalating on the first one would drag a vision
    // screenshot into nearly every step.
    if (notice.result.error.code === "E_STALE_REF" && state.consecutiveFailures === 1) {
      state.rung = "A11Y_FULL";
      state.snapshotId = null;
      return;
    }
    if (state.consecutiveFailures === 2 && state.rung === "A11Y_FULL") {
      state.rung = "A11Y_SCOPED";
      return;
    }
    if (state.unchangedFailures >= 2) {
      state.rung = state.rung === "VISION_COORDS" ? "TAKEOVER" : "VISION_COORDS";
      return;
    }
    if (state.rung === "A11Y_SCOPED") state.rung = "ELEMENT_SHOT";
    else if (state.rung === "ELEMENT_SHOT") state.rung = "VISION_COORDS";
    else if (state.rung === "VISION_COORDS") state.rung = "TAKEOVER";
  }

  private inspectSnapshot(state: HybridState, result: ToolResult): void {
    if (!result.ok || !result.data || typeof result.data !== "object") return;
    const data = result.data as Record<string, unknown>;
    if (typeof data.snapshot_id === "string") state.snapshotId = data.snapshot_id;
    const yaml = typeof data.yaml === "string" ? data.yaml : "";
    const refs = Array.isArray(data.refs) ? data.refs : [];
    const visibleControls = /\b(button|link|textbox|checkbox|radio|combobox|menuitem)\b/i.test(yaml);
    const visualOnly = /\b(canvas|img|image)\b/i.test(yaml) && !visibleControls;
    const opaqueIframe = /\biframe\b/i.test(yaml) && refs.length === 0;
    if (visualOnly || opaqueIframe || yaml.trim().length === 0) {
      state.rung = "VISION_COORDS";
      return;
    }
    const empty = /(?:generic|button|link)\s+(?:""|'')\s*\[ref=([^\]]+)\]/i.exec(yaml);
    if (empty?.[1]) {
      state.emptyTargetRef = empty[1];
      state.rung = "ELEMENT_SHOT";
    }
  }

  private state(computerId: string): HybridState {
    let state = this.states.get(computerId);
    if (!state) {
      state = initialState();
      this.states.set(computerId, state);
    }
    return state;
  }
}

function refFromTarget(target: string | null): string | null {
  if (!target) return null;
  const index = target.indexOf(":");
  return index < 0 ? target : target.slice(index + 1) || null;
}

export function createHybridDriver(
  resolver: DriverTransportResolver,
  opts: HybridDriverOptions = {},
): HybridDriver {
  return new HybridDriver(resolver, opts);
}
