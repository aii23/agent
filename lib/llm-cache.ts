/**
 * Anthropic prompt-caching helpers.
 *
 * Anthropic supports prompt caching with up to 4 cache breakpoints per request.
 * When a breakpoint is set on a message, everything in the prompt up to and
 * including that message is cached. Subsequent calls reuse the cached prefix
 * at ~10% of the normal input cost (and lower latency).
 *
 * Other providers (xAI, Google, OpenAI) silently ignore the
 * `providerOptions.anthropic` block — these helpers are safe to use unconditionally.
 *
 * Reference: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
 */

import type {
  ModelMessage,
  SystemModelMessage,
  ProviderOptions,
} from "@ai-sdk/provider-utils";

/** Provider options block that creates an Anthropic ephemeral cache breakpoint. */
export const CACHE_BREAKPOINT: ProviderOptions = {
  anthropic: { cacheControl: { type: "ephemeral" } },
};

/**
 * Build a system message with an Anthropic cache breakpoint attached.
 * Use as the `system` prop on `generateText`/`streamText` to cache long, static
 * system prompts (manager personas, executor briefs, planner instructions).
 */
export function cachedSystem(content: string): SystemModelMessage {
  return {
    role: "system",
    content,
    providerOptions: CACHE_BREAKPOINT,
  };
}

/**
 * Attach a cache breakpoint to an existing message without mutating it.
 * Typically used on the LAST message of a stable prefix block (e.g. the last
 * conversation-history message) so the entire prefix caches.
 */
export function withCacheBreakpoint<T extends ModelMessage>(message: T): T {
  return {
    ...message,
    providerOptions: {
      ...(message.providerOptions ?? {}),
      ...CACHE_BREAKPOINT,
    },
  };
}
