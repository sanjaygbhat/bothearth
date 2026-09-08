import { registerAdapter } from "./registry.ts";
import {
  createAnthropicAdapter,
  anthropicOptionsFromConfig,
} from "./anthropic.ts";
import {
  createOpenAICompatibleAdapter,
  openAICompatibleOptionsFromConfig,
} from "./openai-compatible.ts";

registerAdapter("openai_compat", ({ endpoint, apiKey }) => ({
  kind: "openai_compat",
  // Built per call, not per process: a standalone task validates the configured
  // model at the moment it is used, while harness tasks never touch it at all.
  async complete(request) {
    return createOpenAICompatibleAdapter(
      openAICompatibleOptionsFromConfig(endpoint, apiKey),
    ).complete(request);
  },
}));

registerAdapter("anthropic", ({ endpoint, apiKey }) =>
  createAnthropicAdapter(anthropicOptionsFromConfig(endpoint, apiKey)),
);

export {
  registerAdapter,
  registeredAdapterNames,
  createAdapter,
} from "./registry.ts";
