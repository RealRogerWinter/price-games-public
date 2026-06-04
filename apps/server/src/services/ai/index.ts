/**
 * AI provider factory.
 *
 * Creates the appropriate AI provider based on configuration.
 * Currently supports Claude (Anthropic) with the ability to add
 * more providers in the future.
 */

import type { AIProvider } from "./types";
import { createClaudeProvider } from "./claude-provider";

/**
 * Create an AI provider from configuration.
 *
 * @param providerName - Provider identifier ("claude").
 * @param apiKey - API key for the provider.
 * @param model - Model identifier.
 * @returns An AIProvider instance.
 * @throws If the provider name is unknown or the API key is missing.
 */
export function createAIProvider(providerName: string, apiKey: string, model: string): AIProvider {
  if (!apiKey) {
    throw new Error(`AI provider "${providerName}" requires an API key`);
  }

  switch (providerName) {
    case "claude":
      return createClaudeProvider(apiKey, model);
    default:
      throw new Error(`Unknown AI provider: ${providerName}`);
  }
}

export type { AIProvider, AIMessage, AIGenerateOptions, AITextResult, AIStructuredResult } from "./types";
