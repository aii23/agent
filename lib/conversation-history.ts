/**
 * Conversation history helpers for the chat planner.
 *
 * Replaying full history on every turn grows linearly in token cost. This
 * module returns a bounded, cleaned slice that preserves recent context while
 * capping spend, and marks the last message as an Anthropic cache breakpoint
 * so the entire history prefix caches between turns.
 */

import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { Message } from "@prisma/client";
import { withCacheBreakpoint } from "@/lib/llm-cache";

/** Keep at most this many user/assistant messages (≈ N/2 turns). */
export const HISTORY_MESSAGE_LIMIT = 12;

/**
 * Approximate token budget for the replayed history block.
 * Uses the standard 1 token ≈ 4 chars heuristic.
 */
export const HISTORY_TOKEN_LIMIT = 4_000;

type HistoryMessage = Pick<Message, "id" | "role" | "content" | "status">;

/**
 * Build a bounded message history suitable for replay into a planning call.
 *
 * Rules:
 *  - Excludes the triggering message (it gets appended separately as the new user turn).
 *  - Keeps only DONE messages (drops PENDING/STREAMING/FAILED rows).
 *  - Caps to the last HISTORY_MESSAGE_LIMIT messages.
 *  - Trims further if total characters exceed HISTORY_TOKEN_LIMIT × 4.
 *  - Tags the last message with an Anthropic cache breakpoint so the entire
 *    history prefix is cached on subsequent turns.
 */
export function buildBoundedHistory(
  messages: HistoryMessage[],
  excludeMessageId: string,
): ModelMessage[] {
  const filtered = messages
    .filter((m) => m.id !== excludeMessageId && m.status === "DONE")
    .slice(-HISTORY_MESSAGE_LIMIT);

  // Walk newest → oldest, keep adding until we blow the char budget
  const charLimit = HISTORY_TOKEN_LIMIT * 4;
  const kept: HistoryMessage[] = [];
  let runningChars = 0;
  for (let i = filtered.length - 1; i >= 0; i--) {
    runningChars += filtered[i].content.length;
    if (runningChars > charLimit && kept.length > 0) break;
    kept.unshift(filtered[i]);
  }

  const history: ModelMessage[] = kept.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  if (history.length > 0) {
    history[history.length - 1] = withCacheBreakpoint(
      history[history.length - 1],
    );
  }

  return history;
}
