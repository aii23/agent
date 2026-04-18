/**
 * Notion Index — sync engine and query helpers
 *
 * Maintains a cached snapshot of the Notion workspace in Postgres.
 * Each page is stored with its title, breadcrumb path, and a 1-2 sentence
 * LLM-generated summary so managers can select relevant pages without
 * fetching full content.
 *
 * Usage:
 *   await syncNotionIndex()                     // full sync (initial setup)
 *   await syncNotionIndexIncremental()           // sync only changed pages
 *   const index = await getNotionIndex(scope)    // read for a specific agent
 *   const text  = formatNotionIndex(index)       // format for LLM injection
 *
 * Run a full sync from the CLI:
 *   npx tsx lib/notion-index.ts
 */

import { Client } from "@notionhq/client"
import type {
  PageObjectResponse,
  BlockObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints"
import { generateText } from "ai"
import { prisma } from "@/lib/prisma"
import { resolveModel } from "@/lib/llm"

import { config } from "dotenv"
config({ path: ".env.local" })

// ── Types ──────────────────────────────────────────────────────────────────

/** Subset of notionScope stored on Agent.notionScope */
export interface NotionScope {
  pageIds?: string[]
  databaseIds?: string[]
}

/** Row shape returned by getNotionIndex — no raw content, just metadata */
export interface NotionPageIndex {
  id: string
  title: string
  path: string
  summary: string
  parentId: string | null
  databaseId: string | null
  lastEditedAt: Date
}

// ── Notion client ──────────────────────────────────────────────────────────

function getNotionClient(): Client {
  const token = process.env.NOTION_TOKEN
  if (!token) throw new Error("NOTION_TOKEN is not set in environment")
  return new Client({ auth: token })
}

// ── Page content helpers ───────────────────────────────────────────────────

function richTextToPlain(items: RichTextItemResponse[]): string {
  return items.map((item) => item.plain_text).join("")
}

function extractBlockText(block: BlockObjectResponse): string {
  const type = block.type
  const data = (block as Record<string, unknown>)[type] as
    | { rich_text?: RichTextItemResponse[]; title?: RichTextItemResponse[] }
    | undefined

  if (!data) return ""
  if (data.rich_text) return richTextToPlain(data.rich_text)
  if (data.title) return richTextToPlain(data.title)
  return ""
}

/**
 * Recursively fetch plain-text content for a page or block.
 * Stops at depth 3 to avoid unbounded recursion on deeply nested pages.
 */
async function fetchBlockText(
  notion: Client,
  blockId: string,
  depth = 0,
): Promise<string> {
  if (depth > 3) return ""

  const texts: string[] = []
  let cursor: string | undefined = undefined

  do {
    const response = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    })

    for (const block of response.results as BlockObjectResponse[]) {
      const text = extractBlockText(block)
      if (text) texts.push(text)

      if (block.has_children) {
        const childText = await fetchBlockText(notion, block.id, depth + 1)
        if (childText) texts.push(childText)
      }
    }

    cursor = response.next_cursor ?? undefined
  } while (cursor)

  return texts.join("\n")
}

/** Public: fetch the full plain-text content of a Notion page */
export async function fetchPageText(pageId: string): Promise<string> {
  const notion = getNotionClient()
  return fetchBlockText(notion, pageId)
}

// ── Page tree helpers ──────────────────────────────────────────────────────

function extractTitle(page: PageObjectResponse): string {
  const titleProp = Object.values(page.properties).find(
    (p) => p.type === "title",
  )
  if (titleProp?.type === "title") {
    return richTextToPlain(titleProp.title) || "Untitled"
  }
  return "Untitled"
}

function extractParent(page: PageObjectResponse): {
  parentId?: string
  databaseId?: string
} {
  if (page.parent.type === "page_id") return { parentId: page.parent.page_id }
  if (page.parent.type === "database_id")
    return { databaseId: page.parent.database_id }
  return {}
}

interface RawPage {
  id: string
  title: string
  parentId?: string
  databaseId?: string
  lastEditedAt: Date
}

/** Fetch every page in the workspace (search API, paginated) */
export async function fetchPageTree(): Promise<RawPage[]> {
  const notion = getNotionClient()
  const pages: RawPage[] = []
  let cursor: string | undefined = undefined

  do {
    const response = await notion.search({
      filter: { property: "object", value: "page" },
      start_cursor: cursor,
      page_size: 100,
    })

    for (const result of response.results) {
      if (result.object !== "page") continue
      const page = result as PageObjectResponse
      const { parentId, databaseId } = extractParent(page)

      pages.push({
        id: page.id,
        title: extractTitle(page),
        parentId,
        databaseId,
        lastEditedAt: new Date(page.last_edited_time),
      })
    }

    cursor = response.next_cursor ?? undefined
  } while (cursor)

  return pages
}

/** Build a human-readable breadcrumb path from parent chain */
function buildPath(
  pageId: string,
  pageMap: Map<string, { title: string; parentId?: string }>,
): string {
  const parts: string[] = []
  let current: string | undefined = pageId
  const visited = new Set<string>()

  while (current && !visited.has(current)) {
    visited.add(current)
    const page = pageMap.get(current)
    if (!page) break
    parts.unshift(page.title)
    current = page.parentId
  }

  return parts.join(" / ") || "Untitled"
}

/**
 * Sample content from a large document without truncating to just the intro.
 * Takes the first 60% and last 40% of the budget so conclusions/decisions
 * at the end of long docs aren't silently dropped.
 */
function sampleContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  const headChars = Math.floor(maxChars * 0.6)
  const tailChars = maxChars - headChars
  return (
    content.slice(0, headChars) +
    "\n\n[…content omitted…]\n\n" +
    content.slice(-tailChars)
  )
}

/**
 * Generate an index summary for a Notion page.
 *
 * The summary's only job is to help the manager SELECT which pages to fetch —
 * not to carry content. But for large multi-section documents the manager
 * needs to know what sections exist, otherwise it will miss relevant pages.
 *
 * Summary format scales with document size:
 *   Small  (< 3K chars)  → 1-2 sentence factual summary
 *   Medium (3K-15K chars) → 2-3 sentences, mentions key topics covered
 *   Large  (> 15K chars) → structured: "Sections: [...]. Overview: [...]"
 */
async function generatePageSummary(
  title: string,
  content: string,
): Promise<string> {
  if (!content.trim()) return `Empty page titled "${title}".`

  const len = content.length

  let systemPrompt: string
  let inputBudget: number
  let maxOutputTokens: number

  if (len < 3_000) {
    // Short page — a tight factual sentence is enough
    systemPrompt =
      "Summarise this Notion page in 1-2 sentences. Include specific facts: names, dates, numbers, or decisions. No preamble."
    inputBudget = 3_000
    maxOutputTokens = 80
  } else if (len < 15_000) {
    // Medium page — mention the main topics so the manager knows what's inside
    systemPrompt =
      "Summarise this Notion page in 2-3 sentences. First sentence: what the page is about. Remaining sentences: list the key topics or decisions covered. Be specific — include names, dates, numbers. No preamble."
    inputBudget = 8_000
    maxOutputTokens = 150
  } else {
    // Large document — provide a section map + one-line overview
    // The manager needs to know sections exist to decide whether to fetch this page
    systemPrompt = `Summarise this Notion page using exactly this format:
Sections: [comma-separated list of the main sections or topics covered]
Overview: [1-2 sentences describing the document's purpose and primary focus]

Be specific: include names, dates, numbers. No preamble. No other text.`
    inputBudget = 12_000 // sampled from beginning + end
    maxOutputTokens = 200
  }

  const sampled = sampleContent(content, inputBudget)

  const result = await generateText({
    model: resolveModel("gemini-flash"),
    maxOutputTokens,
    system: systemPrompt,
    prompt: `Page title: ${title}\n\nContent:\n${sampled}`,
  })

  return result.text.trim()
}

// ── Sync functions ─────────────────────────────────────────────────────────

/** Upsert a single page into the NotionPage cache */
async function upsertPage(page: RawPage, path: string, raw: string) {
  const summary = await generatePageSummary(page.title, raw)

  await prisma.notionPage.upsert({
    where: { id: page.id },
    create: {
      id: page.id,
      title: page.title,
      path,
      summary,
      parentId: page.parentId ?? null,
      databaseId: page.databaseId ?? null,
      lastEditedAt: page.lastEditedAt,
      raw: raw || null,
    },
    update: {
      title: page.title,
      path,
      summary,
      parentId: page.parentId ?? null,
      databaseId: page.databaseId ?? null,
      lastEditedAt: page.lastEditedAt,
      raw: raw || null,
      syncedAt: new Date(),
    },
  })
}

/** Process pages in batches to respect Notion rate limits */
async function processBatches(
  pages: RawPage[],
  pageMap: Map<string, { title: string; parentId?: string }>,
  batchSize = 8,
): Promise<number> {
  let synced = 0

  for (let i = 0; i < pages.length; i += batchSize) {
    const batch = pages.slice(i, i + batchSize)

    await Promise.all(
      batch.map(async (page) => {
        const path = buildPath(page.id, pageMap)
        const raw = await fetchPageText(page.id)
        await upsertPage(page, path, raw)
        synced++
        console.log(`  [sync] ${synced}/${pages.length} — ${path}`)
      }),
    )
  }

  return synced
}

/**
 * Full sync: fetch every page in the workspace, generate summaries, upsert all.
 * Use for initial setup or after bulk Notion changes.
 */
export async function syncNotionIndex(): Promise<{ synced: number }> {
  console.log("[notion-index] Starting full sync…")
  const pages = await fetchPageTree()
  console.log(`[notion-index] Found ${pages.length} pages in workspace`)

  const pageMap = new Map(
    pages.map((p) => [p.id, { title: p.title, parentId: p.parentId }]),
  )

  const synced = await processBatches(pages, pageMap)
  console.log(`[notion-index] Full sync complete — ${synced} pages upserted`)
  return { synced }
}

/**
 * Incremental sync: only re-sync pages edited since our last sync.
 * Use for webhook-triggered or scheduled background refreshes.
 */
export async function syncNotionIndexIncremental(): Promise<{ synced: number }> {
  const latest = await prisma.notionPage.findFirst({
    orderBy: { syncedAt: "desc" },
    select: { syncedAt: true },
  })

  const since = latest?.syncedAt ?? new Date(0)
  console.log(`[notion-index] Incremental sync — checking pages edited after ${since.toISOString()}`)

  const allPages = await fetchPageTree()
  const outdated = allPages.filter((p) => p.lastEditedAt > since)

  if (outdated.length === 0) {
    console.log("[notion-index] Nothing to sync — all pages up to date")
    return { synced: 0 }
  }

  console.log(`[notion-index] ${outdated.length} pages need updating`)

  const pageMap = new Map(
    allPages.map((p) => [p.id, { title: p.title, parentId: p.parentId }]),
  )

  const synced = await processBatches(outdated, pageMap)
  console.log(`[notion-index] Incremental sync complete — ${synced} pages updated`)
  return { synced }
}

// ── Query helpers ──────────────────────────────────────────────────────────

/**
 * Read the cached index from Postgres.
 * Pass an agent's notionScope to filter to only the pages that agent can access.
 * With no scope, returns all pages.
 */
export async function getNotionIndex(
  scope?: NotionScope,
): Promise<NotionPageIndex[]> {
  const where: Parameters<typeof prisma.notionPage.findMany>[0] extends
    | { where?: infer W }
    | undefined
    ? W
    : never = {}

  if (scope?.pageIds?.length || scope?.databaseIds?.length) {
    ;(where as Record<string, unknown>).OR = [
      ...(scope.pageIds?.length ? [{ id: { in: scope.pageIds } }] : []),
      ...(scope.databaseIds?.length
        ? [{ databaseId: { in: scope.databaseIds } }]
        : []),
    ]
  }

  return prisma.notionPage.findMany({
    where: where as Parameters<typeof prisma.notionPage.findMany>[0]["where"],
    select: {
      id: true,
      title: true,
      path: true,
      summary: true,
      parentId: true,
      databaseId: true,
      lastEditedAt: true,
    },
    orderBy: { path: "asc" },
  })
}

/**
 * Format the index as a compact string ready to inject into an LLM prompt.
 *
 * Example output line:
 *   [abc123] Strategy / Q3 / OKRs
 *     → Defines the three OKRs for Q3 2025: revenue growth, churn reduction, and hiring plan.
 */
export function formatNotionIndex(pages: NotionPageIndex[]): string {
  if (pages.length === 0) return "No Notion pages available for this agent."

  return pages
    .map((p) => `[${p.id}] ${p.path}\n  → ${p.summary}`)
    .join("\n")
}

// ── CLI entry point ────────────────────────────────────────────────────────

// Run: npx tsx lib/notion-index.ts [--incremental]
if (require.main === module) {
  const incremental = process.argv.includes("--incremental")
  const fn = incremental ? syncNotionIndexIncremental : syncNotionIndex

  fn()
    .then(({ synced }) => {
      console.log(`Done. Synced ${synced} pages.`)
      process.exit(0)
    })
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
    .finally(() => prisma.$disconnect())
}
