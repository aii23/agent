import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { google } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

import { config } from "dotenv";
config({ path: ".env.local" });

const MODEL_REGISTRY: Record<string, LanguageModel> = {
  "claude-opus": anthropic("claude-opus-4-7"),
  "claude-sonnet": anthropic("claude-sonnet-4-6"),
  "claude-haiku": anthropic("claude-haiku-4-5-20251001"),
  "gemini-flash": google("gemini-3.0-flash"),
  // "gpt-4o-mini": openai("gpt-4o-mini"),
};

/**
 * Resolves a model key (stored on the Agent record) to a concrete LanguageModel.
 * Falls back to claude-sonnet for unknown keys.
 */
export function resolveModel(model: string): LanguageModel {
  return MODEL_REGISTRY[model] ?? MODEL_REGISTRY["claude-sonnet"];
}
