/**
 * Adapter registry: name → factory. The built-ins register in
 * `src/adapters/index.ts`; a contributor's provider registers there too.
 */
import type { ProviderAdapter } from "../types/contracts.ts";
import type { AdapterContext, AdapterFactory } from "./types.ts";

const factories = new Map<string, AdapterFactory>();

export function registerAdapter(name: string, factory: AdapterFactory): void {
  if (factories.has(name)) {
    throw new Error(`adapter already registered: ${name}`);
  }
  factories.set(name, factory);
}

/** Registration order, which is the order the daemon builds adapters in. */
export function registeredAdapterNames(): string[] {
  return [...factories.keys()];
}

export function createAdapter(ctx: AdapterContext): ProviderAdapter {
  const factory = factories.get(ctx.name);
  if (!factory) {
    throw new Error(
      `unknown adapter "${ctx.name}"; registered: ${registeredAdapterNames().join(", ") || "none"}`,
    );
  }
  return factory(ctx);
}
