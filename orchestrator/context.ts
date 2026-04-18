/**
 * Notion Context Builder
 *
 * Two-step pipeline that turns a list of Notion page IDs into a dense,
 * focused context string ready for injection into executor prompts.
 *
 * Step 1 — Fetch: read raw page content from the Postgres cache.
 *           Falls back to a live Notion API call if the cache is stale (>7d).
 *           Summaries and the index are only updated by explicit sync (pnpm notion:sync).
 *
 * Step 2 — Compress: call gemini-flash to distil only the information
 *           relevant to the user's request, capped at ~1500 tokens.
 *
 * The result is stored on ExecutionPlan.notionContext and injected into
 * executor promptTemplates via the {{notionContext}} template variable.
 *
 * Usage (inside orchestrator/plan.ts):
 *   const notionContext = await buildNotionContext(plan.notionPageIds, userMessage.content)
 *
 * Usage (inside executor promptTemplate):
 *   "Generate a post about {{userRequest}}. Brand context:\n{{notionContext}}"
 */

import { generateText } from "ai";
import { prisma } from "@/lib/prisma";
import { resolveModel } from "@/lib/llm";
import { fetchPageText } from "@/lib/notion-index";

// ── Constants ──────────────────────────────────────────────────────────────

/** How long to trust the raw cache before re-fetching from Notion */
const RAW_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Max characters to read from a single page before truncating.
 * 20K chars ≈ 5K tokens — covers most full Notion pages including long specs.
 */
const MAX_CHARS_PER_PAGE = 20_000;

/**
 * Max total characters sent to the compression LLM.
 * 150K chars ≈ 37K tokens — comfortably fits 5-10 dense pages.
 *
 * We use gemini-flash which has a 1M token context window at $0.075/1M input
 * tokens. Raising this limit costs ~$0.003 per full compression call — the
 * right trade-off vs. silently truncating relevant content.
 *
 * Hard ceiling is 400K chars (≈100K tokens) if you need to cover unusually
 * large scopes. Do not use a "bigger" model — Flash's context window is larger
 * than Sonnet's (1M vs 200K) and it's 40x cheaper for this extraction task.
 */
const MAX_TOTAL_INPUT_CHARS = 150_000;

// ── Types ──────────────────────────────────────────────────────────────────

interface FetchedPage {
  id: string;
  title: string;
  path: string;
  content: string;
}

// ── Step 1: Fetch ──────────────────────────────────────────────────────────

/**
 * Load raw content for the given page IDs.
 *
 * Priority order:
 *   1. Postgres cache (NotionPage.raw) — if fresher than RAW_CACHE_TTL_MS
 *   2. Live Notion API call — result written back to cache for next time
 *
 * Pages missing from the index (never synced) are silently skipped.
 */
async function fetchSelectedPages(pageIds: string[]): Promise<FetchedPage[]> {
  if (pageIds.length === 0) return [];

  const cached = await prisma.notionPage.findMany({
    where: { id: { in: pageIds } },
    select: { id: true, title: true, path: true, raw: true, syncedAt: true },
  });

  const now = Date.now();

  return Promise.all(
    cached.map(async (page): Promise<FetchedPage> => {
      const isStale =
        !page.raw || now - page.syncedAt.getTime() > RAW_CACHE_TTL_MS;

      let content = page.raw ?? "";

      if (isStale) {
        try {
          content = await fetchPageText(page.id);
          // Only refresh raw content — summary stays as-is until the next
          // explicit sync (pnpm notion:sync). Fire-and-forget.
          prisma.notionPage
            .update({
              where: { id: page.id },
              data: { raw: content, syncedAt: new Date() },
            })
            .catch((err) =>
              console.warn(
                `[context] Raw cache refresh failed for ${page.id}:`,
                err.message,
              ),
            );
        } catch (err) {
          console.warn(
            `[context] Could not fetch live content for ${page.id}:`,
            (err as Error).message,
          );
          // Fall through — use stale cache or empty string
        }
      }

      return { id: page.id, title: page.title, path: page.path, content };
    }),
  );
}

// ── Step 2: Compress ───────────────────────────────────────────────────────

/**
 * Build the raw content block for the compression LLM.
 * Pages are concatenated in order; once total characters exceed MAX_TOTAL_INPUT_CHARS,
 * remaining pages are skipped (least relevant last — managers should order by priority).
 */
function buildRawContentBlock(pages: FetchedPage[]): string {
  const blocks: string[] = [];
  let totalChars = 0;

  for (const page of pages) {
    const capped = page.content.slice(0, MAX_CHARS_PER_PAGE);
    if (totalChars + capped.length > MAX_TOTAL_INPUT_CHARS) break;
    totalChars += capped.length;
    blocks.push(`## ${page.path}\n\n${capped || "(No content)"}`);
  }

  return blocks.join("\n\n---\n\n");
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Compress selected Notion pages into a focused context string.
 *
 * Returns an empty string if no page IDs are provided.
 * Returns a structured markdown string (300–1500 tokens) otherwise.
 *
 * The output length scales naturally with content relevance — simple queries
 * (e.g. "what's our brand voice?") produce short outputs; complex multi-page
 * tasks (e.g. "review Q3 OKRs and propose Q4 priorities") use the full budget.
 *
 * Token budget rationale:
 *   - 700 tokens: too lossy for multi-page research (drops specific facts)
 *   - 1500 tokens: covers most tasks including CLO/CFO document analysis
 *   - 3000 tokens: ceiling for unusually dense document sets (configurable)
 *   Cost delta (Flash at $0.30/1M output): 700→1500 = $0.00024 per call
 */
export async function buildNotionContext(
  pageIds: string[],
  userRequest: string,
  maxOutputTokens = 1_500,
): Promise<string> {
  if (pageIds.length === 0) return "";

  const pages = await fetchSelectedPages(pageIds);

  if (pages.length === 0) {
    console.warn(
      `[context] None of the requested page IDs found in index: ${pageIds.join(", ")}`,
    );
    return "";
  }

  const rawContentBlock = buildRawContentBlock(pages);

  const result = await generateText({
    model: resolveModel("claude-haiku"),
    maxOutputTokens,
    system: `You are a context extractor for an AI agent system.
Given a set of Notion pages and a user's request, extract only the information relevant to completing that request.

Rules:
- Output structured markdown with clear section headers
- Preserve specific facts: names, dates, numbers, decisions, and verbatim short quotes
- Omit sections entirely if they are not relevant to the user's request
- Do not summarise facts into vague descriptions — keep the specifics
- Do not explain what you are doing — output only the extracted context`,
    prompt: `User request: "${userRequest}"

---

${rawContentBlock}`,
  });

  return result.text.trim();
}

/**
 * Lightweight wrapper used in handleManagerPlan to build and persist context
 * in one call. Returns empty string if pageIds is empty or undefined.
 */
export async function buildAndPersistNotionContext(
  executionPlanId: string,
  pageIds: string[] | undefined,
  userRequest: string,
  maxOutputTokens?: number,
): Promise<string> {
  if (!pageIds?.length) return "";

  const notionContext = await buildNotionContext(
    pageIds,
    userRequest,
    maxOutputTokens,
  );

  if (notionContext) {
    await prisma.executionPlan.update({
      where: { id: executionPlanId },
      data: { notionContext },
    });
  }

  return notionContext;
}
