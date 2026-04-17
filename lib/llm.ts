import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

const MODEL_REGISTRY: Record<string, LanguageModel> = {
  "claude-opus": anthropic("claude-opus-4-20250514"),
  "claude-sonnet": anthropic("claude-sonnet-4-20250514"),
  "claude-haiku": anthropic("claude-haiku-4-20260307"),
  // "gemini-flash": google("gemini-2.0-flash"),
  // "gpt-4o-mini": openai("gpt-4o-mini"),
};

/**
 * Resolves a model key (stored on the Agent record) to a concrete LanguageModel.
 * Falls back to claude-sonnet for unknown keys.
 */
export function resolveModel(model: string): LanguageModel {
  return MODEL_REGISTRY[model] ?? MODEL_REGISTRY["claude-sonnet"];
}
