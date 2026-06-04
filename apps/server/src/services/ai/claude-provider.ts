/**
 * Claude (Anthropic) AI provider implementation.
 *
 * Wraps the @anthropic-ai/sdk to implement the AIProvider interface
 * for text generation and structured JSON extraction.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider, AIMessage, AIGenerateOptions, AITextResult, AIStructuredResult } from "./types";

/**
 * Create a Claude AI provider.
 *
 * @param apiKey - Anthropic API key.
 * @param defaultModel - Default model ID (e.g. "claude-sonnet-4-20250514").
 * @returns An AIProvider backed by the Anthropic API.
 */
export function createClaudeProvider(apiKey: string, defaultModel: string): AIProvider {
  const client = new Anthropic({ apiKey });

  return {
    async generateText(messages: AIMessage[], options?: AIGenerateOptions): Promise<AITextResult> {
      const systemMessage = messages.find((m) => m.role === "system");
      const nonSystemMessages = messages.filter((m) => m.role !== "system");

      const response = await client.messages.create({
        model: options?.model || defaultModel,
        max_tokens: options?.maxTokens || 4096,
        temperature: options?.temperature ?? 0.3,
        ...(systemMessage ? { system: systemMessage.content } : {}),
        messages: nonSystemMessages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      });

      const textBlock = response.content.find((b) => b.type === "text");
      return {
        text: textBlock?.type === "text" ? textBlock.text : "",
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    },

    async generateStructured<T>(
      messages: AIMessage[],
      schema: Record<string, unknown>,
      options?: AIGenerateOptions,
    ): Promise<AIStructuredResult<T>> {
      const schemaInstructions = `Respond ONLY with valid JSON matching this schema:\n${JSON.stringify(schema, null, 2)}`;
      const systemMessage = messages.find((m) => m.role === "system");
      const nonSystemMessages = messages.filter((m) => m.role !== "system");

      const systemContent = systemMessage
        ? `${systemMessage.content}\n\n${schemaInstructions}`
        : schemaInstructions;

      const response = await client.messages.create({
        model: options?.model || defaultModel,
        max_tokens: options?.maxTokens || 4096,
        temperature: options?.temperature ?? 0.1,
        system: systemContent,
        messages: nonSystemMessages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      });

      const textBlock = response.content.find((b) => b.type === "text");
      const rawText = textBlock?.type === "text" ? textBlock.text : "{}";

      // Extract JSON from potential markdown code blocks
      const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, rawText];
      const jsonStr = (jsonMatch[1] || rawText).trim();
      const data = JSON.parse(jsonStr) as T;

      return {
        data,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    },
  };
}
