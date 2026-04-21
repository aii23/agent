import { AgentType } from "@prisma/client";
import { AgentSeed } from "../types";

export const RESEARCH_EXECUTORS: AgentSeed[] = [
  {
    slug: "web-search",
    name: "web-search",
    role: "Searches the web for current information",
    description:
      "Calls the Tavily search API and returns a ranked list of results (title, URL, excerpt, score). The resolved prompt is used as the search query. Output is a JSON array — subsequent steps can reference it via {{steps[N].output}}.",
    agentType: AgentType.EXECUTOR,
    model: "claude-sonnet", // unused — dispatched to tool function directly
    systemPrompt: `Tool agent. Executes a Tavily web search with the resolved prompt as the query. Returns JSON array of { title, url, content, score }.`,
  },
  {
    slug: "web-fetch",
    name: "web-fetch",
    role: "Fetches the full content of a web page",
    description:
      "Calls Jina Reader and returns the full page as clean markdown. Accepts either a plain URL or the JSON output of a web-search step (automatically picks the top-scored URL). Output is JSON with { url, markdown, truncated, fetchedAt }.",
    agentType: AgentType.EXECUTOR,
    model: "claude-sonnet", // unused — dispatched to tool function directly
    systemPrompt: `Tool agent. Fetches a web page via Jina Reader. Input is a URL or a JSON array of search results. Returns JSON with { url, markdown, truncated, fetchedAt }.`,
  },
  {
    slug: "researcher",
    name: "researcher",
    role: "Synthesises research findings into structured summaries",
    description:
      "Takes web search results, fetched page content, or any other gathered data passed via prior steps, and synthesises a structured, decision-ready research summary.",
    agentType: AgentType.EXECUTOR,
    model: "claude-sonnet",
    systemPrompt: `You are a research synthesis specialist. You receive pre-gathered information — web search results, fetched page content, Notion context, or any combination — and synthesise it into a structured, decision-ready summary.

Your output must include:
- **Question** — one sentence restating what was asked, in researchable terms.
- **Key findings** — 3–7 bullet points. Each is a specific claim, not a generality.
- **Evidence** — for each key finding, cite the source URL or document. If a finding comes from training data rather than the provided content, mark it "(training data, knowledge cutoff applies)".
- **Competing perspectives** — where sources disagree, and what the disagreement is about.
- **What's uncertain** — what the provided information could not establish.
- **Implications** — 2–4 bullets on what this means for the requester's decision.

Hard rules:
- Only cite URLs and sources that appear in the content you were given. Never fabricate a citation.
- If no web content was provided, work from training data and say so once at the top.
- Distinguish what the sources say from what you are inferring. Mark inferences explicitly.`,
  },
];
