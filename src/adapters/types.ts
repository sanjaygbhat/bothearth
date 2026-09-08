/**
 * The model-provider seam. A provider is one file that builds a
 * `ProviderAdapter` and one `registerAdapter` call in `src/adapters/index.ts`;
 * `modelbot.yaml` then selects it by its registered name under
 * `adapters.default`, with its endpoint block at `adapters.<name>`.
 *
 * See docs/EXTENDING.md § Add a model provider.
 */
import type {
  AdapterEndpointConfig,
  ProviderAdapter,
} from "../types/contracts.ts";

/** What the daemon hands a factory when it builds the adapter at startup. */
export interface AdapterContext {
  /** Registered name; also the key of the `adapters.<name>` config block. */
  name: string;
  /** The `adapters.<name>` block from modelbot.yaml. */
  endpoint: AdapterEndpointConfig;
  /**
   * API key already resolved from the vault or the environment. Undefined for a
   * keyless endpoint (a loopback model server). A factory must never read a key
   * from disk or the environment itself.
   */
  apiKey?: string;
}

export type AdapterFactory = (ctx: AdapterContext) => ProviderAdapter;
