import type { Driver, DriverObserveResult, McpToolDescriptor } from "../types/contracts.ts";
import { TOOL_CATALOGUE } from "../tools/catalog.ts";
import {
  observationHash,
  resolveDriverTransport,
  type DriverTransportResolver,
} from "./a11y.ts";

export const VISION_TOOLS: readonly McpToolDescriptor[] = TOOL_CATALOGUE
  .filter((tool) => tool.driver === "vision" || tool.driver === "system")
  .map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));

export interface VisionDriverOptions {
  maxWidth?: number;
  maxHeight?: number;
}

export class VisionDriver implements Driver {
  readonly kind = "vision" as const;
  readonly tools = VISION_TOOLS;
  private readonly resolver: DriverTransportResolver;
  private readonly opts: VisionDriverOptions;

  constructor(resolver: DriverTransportResolver, opts: VisionDriverOptions = {}) {
    this.resolver = resolver;
    this.opts = opts;
  }

  async observe(computerId: string): Promise<DriverObserveResult> {
    const result = await resolveDriverTransport(this.resolver, computerId).call(
      "browser_screenshot",
      {
        full_page: false,
        max_width: this.opts.maxWidth ?? null,
        max_height: this.opts.maxHeight ?? null,
        snapshot_id: null,
        ref: null,
      },
    );
    return {
      rung: "VISION_COORDS",
      observation: result,
      // Raw pixels contribute to progress detection but are removed before the
      // agent loop serialises model/transcript text.
      observation_hash: observationHash(result),
    };
  }
}

export function createVisionDriver(
  resolver: DriverTransportResolver,
  opts: VisionDriverOptions = {},
): VisionDriver {
  return new VisionDriver(resolver, opts);
}
