import crypto from "node:crypto";
import { redis } from "@/lib/redis";

const TAVILY_API = "https://api.tavily.com/search";
const CACHE_TTL_SECONDS = 60 * 60; // 1 hour

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

/**
 * Calls the Tavily search API and returns ranked results.
 * Results are cached in Redis for 1 hour keyed by query + maxResults.
 *
 * This function is called directly by the execution engine when a plan step
 * targets the "web-search" agent — no LLM involved.
 */
export async function searchWeb(
  query: string,
  maxResults = 5,
): Promise<SearchResult[]> {
  const cacheKey = `tavily:${crypto
    .createHash("sha1")
    .update(`${query}:${maxResults}`)
    .digest("hex")}`;

  const cached = await redis.get(cacheKey);
  if (cached) {
    console.log(`[web-search] cache hit — query="${query}"`);
    return JSON.parse(cached) as SearchResult[];
  }

  const apiKey = process.env.TAVILY_KEY;
  if (!apiKey) throw new Error("TAVILY_KEY is not set");

  console.log(
    `[web-search] searching — query="${query}" maxResults=${maxResults}`,
  );

  const response = await fetch(TAVILY_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: maxResults,
      include_answer: false,
      include_raw_content: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Tavily error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    results?: Array<{
      title: string;
      url: string;
      content: string;
      score: number;
    }>;
  };

  const results: SearchResult[] = (data.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.content,
    score: r.score,
  }));

  await redis.set(
    cacheKey,
    JSON.stringify(results),
    "EX",
    CACHE_TTL_SECONDS,
  );
  console.log(`[web-search] ${results.length} results cached`);

  return results;
}
