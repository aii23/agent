import crypto from "node:crypto";
import { redis } from "@/lib/redis";
import type { SearchResult } from "./web-search";

const JINA_BASE = "https://r.jina.ai";
const CACHE_TTL_SECONDS = 60 * 60 * 24; // 24 hours
const MAX_CHARS = 20_000; // ~5k tokens

export interface FetchResult {
  url: string;
  markdown: string;
  truncated: boolean;
  fetchedAt: string;
}

/**
 * Resolves the input string to a concrete URL.
 *
 * Accepts two input shapes from the plan template:
 *   1. A plain URL string: "https://example.com/page"
 *   2. A JSON array of SearchResult (output of a prior web-search step) —
 *      the top-scored result's URL is used automatically.
 *
 * This lets the manager write a plan step like:
 *   { agent: "web-fetch", promptTemplate: "{{steps[0].output}}" }
 * without needing to know the URL in advance.
 */
function resolveUrl(input: string): string {
  const trimmed = input.trim();

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const results = parsed as SearchResult[];
      // Sort by score desc, take the highest-ranked URL
      const top = [...results].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
      if (top?.url) {
        console.log(
          `[web-fetch] resolved top URL from search results: ${top.url}`,
        );
        return top.url;
      }
    }
  } catch {
    // not JSON — fall through to error
  }

  throw new Error(
    `[web-fetch] cannot resolve URL from input: "${trimmed.slice(0, 120)}"`,
  );
}

/**
 * Fetches a web page via Jina Reader and returns clean markdown.
 * The input can be a URL or a JSON array of SearchResult from a prior step.
 * Results are cached in Redis for 24 hours.
 *
 * Called directly by the execution engine when a plan step targets the
 * "web-fetch" agent — no LLM involved.
 */
export async function fetchPage(input: string): Promise<FetchResult> {
  const url = resolveUrl(input);

  const cacheKey = `jina:${crypto
    .createHash("sha1")
    .update(url)
    .digest("hex")}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    console.log(`[web-fetch] cache hit — url="${url}"`);
    return JSON.parse(cached) as FetchResult;
  }

  const apiKey = process.env.JINA_KEY;
  if (!apiKey) throw new Error("JINA_KEY is not set");

  console.log(`[web-fetch] fetching — url="${url}"`);

  const response = await fetch(`${JINA_BASE}/${url}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Return-Format": "markdown",
      Accept: "text/plain",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Jina error ${response.status}: ${body}`);
  }

  const raw = await response.text();
  const truncated = raw.length > MAX_CHARS;
  const markdown = truncated
    ? raw.slice(0, MAX_CHARS) + "\n\n[Content truncated at 20,000 characters]"
    : raw;

  const result: FetchResult = {
    url,
    markdown,
    truncated,
    fetchedAt: new Date().toISOString(),
  };

  await redis.set(cacheKey, JSON.stringify(result), "EX", CACHE_TTL_SECONDS);
  console.log(
    `[web-fetch] fetched ${raw.length} chars${truncated ? " (truncated)" : ""}, cached`,
  );

  return result;
}
