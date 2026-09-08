import { createHash } from "node:crypto";
import type {
  Driver,
  DriverObserveResult,
  McpToolDescriptor,
  ToolResult,
} from "../types/contracts.ts";
import { TOOL_CATALOGUE } from "../tools/catalog.ts";

export interface DriverTransport {
  call(method: string, params?: unknown): Promise<ToolResult>;
}

export type DriverTransportResolver =
  | DriverTransport
  | ((computerId: string) => DriverTransport);

export interface DriverToolResultNotice {
  name: string;
  arguments: Record<string, unknown>;
  result: ToolResult;
  observationHash?: string;
}

export function resolveDriverTransport(
  resolver: DriverTransportResolver,
  computerId: string,
): DriverTransport {
  return typeof resolver === "function" ? resolver(computerId) : resolver;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      // Provider/server-issued ids change on a re-snapshot without page progress.
      .filter(([key]) => key !== "snapshot_id" && key !== "image_id")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, sortJson(item)]),
  );
}

export function observationHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex");
}

export const A11Y_TOOLS: readonly McpToolDescriptor[] = TOOL_CATALOGUE
  .filter((tool) => tool.driver === "a11y" || tool.driver === "system")
  .map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));

export interface A11yDriverOptions {
  snapshotMaxChars?: number;
}

export class A11yDriver implements Driver {
  readonly kind = "a11y" as const;
  readonly tools = A11Y_TOOLS;
  protected readonly resolver: DriverTransportResolver;
  protected readonly snapshotMaxChars: number;
  protected scoped = false;
  protected takeover = false;
  protected lastTarget: string | null = null;
  protected lastSnapshotId: string | null = null;
  private failureTarget: string | null = null;
  private consecutiveFailures = 0;

  constructor(resolver: DriverTransportResolver, opts: A11yDriverOptions = {}) {
    this.resolver = resolver;
    this.snapshotMaxChars = opts.snapshotMaxChars ?? 16_000;
  }

  async observe(computerId: string): Promise<DriverObserveResult> {
    const transport = resolveDriverTransport(this.resolver, computerId);
    if (this.takeover) {
      const result = await transport.call("request_takeover", {
        reason: "Accessibility controls could not safely identify the target.",
        category: "other",
      });
      return {
        rung: "TAKEOVER",
        observation: result,
        observation_hash: observationHash(result),
      };
    }
    const result = await transport.call("browser_snapshot", {
      scope: this.scoped ? this.lastTarget : null,
      interactive_only: true,
      depth: this.scoped ? 6 : null,
      max_chars: this.scoped
        ? Math.min(this.snapshotMaxChars, 8_000)
        : this.snapshotMaxChars,
    });
    if (result.ok && result.data && typeof result.data === "object") {
      const data = result.data as Record<string, unknown>;
      if (typeof data.snapshot_id === "string") this.lastSnapshotId = data.snapshot_id;
    }
    return {
      rung: this.scoped ? "A11Y_SCOPED" : "A11Y_FULL",
      observation: result,
      observation_hash: observationHash(result),
    };
  }

  recordToolResult(notice: DriverToolResultNotice): void {
    const target = toolTarget(notice.arguments);
    if (target) this.lastTarget = target;
    if (notice.result.ok) {
      this.failureTarget = null;
      this.consecutiveFailures = 0;
      return;
    }
    if (!isTargetFailure(notice.result)) return;
    if (target && target === this.failureTarget) this.consecutiveFailures += 1;
    else {
      this.failureTarget = target;
      this.consecutiveFailures = 1;
    }
    // First stale ref is expected: refresh while remaining at A11Y_FULL.
    if (notice.result.error.code === "E_STALE_REF" && this.consecutiveFailures === 1) {
      this.scoped = false;
      return;
    }
    if (this.consecutiveFailures === 2) {
      this.scoped = true;
      return;
    }
    if (this.consecutiveFailures > 2) this.takeover = true;
  }
}

export function toolTarget(args: Record<string, unknown>): string | null {
  const ref = typeof args.ref === "string" ? args.ref : "";
  // snapshot_id necessarily changes during stale-ref recovery; the ref denotes
  // the logical retry target for ladder accounting.
  if (ref) return ref;
  return null;
}

export function isTargetFailure(result: ToolResult): boolean {
  return (
    !result.ok &&
    (result.error.code === "E_STALE_REF" ||
      result.error.code === "E_TIMEOUT" ||
      /not found|unknown ref|missing target|aria-ref/i.test(result.error.message))
  );
}

export function createA11yDriver(
  resolver: DriverTransportResolver,
  opts: A11yDriverOptions = {},
): A11yDriver {
  return new A11yDriver(resolver, opts);
}
