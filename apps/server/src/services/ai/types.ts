/**
 * AI provider abstraction types.
 *
 * Defines a provider-agnostic interface for AI text generation and
 * structured extraction. Implementations can target Claude, OpenAI, etc.
 */

/** A prompt message for AI generation. */
export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Options for AI generation requests. */
export interface AIGenerateOptions {
  /** Maximum tokens to generate. */
  maxTokens?: number;
  /** Sampling temperature (0-1). */
  temperature?: number;
  /** Model override (uses provider default if omitted). */
  model?: string;
}

/** Result from a text generation call. */
export interface AITextResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** Result from a structured extraction call. */
export interface AIStructuredResult<T> {
  data: T;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Provider-agnostic AI interface.
 *
 * Implementations wrap specific AI SDKs (Anthropic, OpenAI, etc.)
 * behind this common interface.
 */
export interface AIProvider {
  /** Generate free-form text from a prompt. */
  generateText(messages: AIMessage[], options?: AIGenerateOptions): Promise<AITextResult>;

  /**
   * Generate structured JSON output conforming to a schema.
   *
   * @param messages - The prompt messages.
   * @param schema - JSON Schema description of the expected output shape.
   * @param options - Generation options.
   * @returns Parsed result matching the schema type parameter.
   */
  generateStructured<T>(
    messages: AIMessage[],
    schema: Record<string, unknown>,
    options?: AIGenerateOptions,
  ): Promise<AIStructuredResult<T>>;
}
