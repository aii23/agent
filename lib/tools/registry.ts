import { searchWeb } from "./web-search";
import { fetchPage } from "./web-fetch";

/**
 * Tool executors are server-side capabilities that the execution engine calls
 * directly when a plan step targets a tool agent slug.
 *
 * Each executor receives the fully-resolved prompt string from the plan step
 * and returns a string that becomes the step's output — available to
 * subsequent steps via {{steps[N].output}}.
 *
 * The manager plans these as ordinary steps. The engine dispatches to the
 * tool function instead of calling an LLM.
 */
export const TOOL_EXECUTORS: Record<
  string,
  (resolvedPrompt: string) => Promise<string>
> = {
  "web-search": async (prompt) => {
    const results = await searchWeb(prompt.trim());
    return JSON.stringify(results, null, 2);
  },

  "web-fetch": async (prompt) => {
    const result = await fetchPage(prompt);
    return JSON.stringify(result, null, 2);
  },
};

/**
 * Returns true if the agent slug is backed by a tool executor rather than
 * an LLM. Used by the execution engine to choose the dispatch path.
 */
export function isToolAgent(slug: string): boolean {
  return slug in TOOL_EXECUTORS;
}
