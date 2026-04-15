/**
 * Agent Worker
 *
 * Picks up jobs from the `agent-queue` BullMQ queue and processes them.
 * Run locally:   pnpm worker
 * Watch mode:    pnpm worker          (tsx watch — auto-restarts on code change)
 * Single run:    pnpm worker:once
 */

import { Worker, type Job } from "bullmq";
import { redis } from "../lib/redis";
import type { AgentJobData, AgentJobName } from "../lib/queue";

// Load .env when running outside Next.js
import { config } from "dotenv";
config({ path: ".env.local" });

const QUEUE_NAME = "agent-queue";
const CONCURRENCY = 5;

// ── Job processor ──────────────────────────────────────────────────────────

async function processAgentJob(
  job: Job<AgentJobData, void, AgentJobName>
): Promise<void> {
  const { runId, conversationId, agentSlug, userMessage, mode } = job.data;

  console.log(
    `[worker] processing job ${job.id} — agent="${agentSlug}" run="${runId}" mode="${mode}"`
  );

  // TODO Day 1 Block 3: replace this stub with the real agent execution
  // import { executeAgent } from "../agents/registry"
  // await executeAgent({ runId, agentSlug, userMessage, conversationId, mode })

  // Simulate work
  await new Promise((r) => setTimeout(r, 500));

  console.log(
    `[worker] completed job ${job.id} — agent="${agentSlug}" message="${userMessage.slice(0, 60)}"`
  );
}

// ── Worker instance ────────────────────────────────────────────────────────

const worker = new Worker<AgentJobData, void, AgentJobName>(
  QUEUE_NAME,
  processAgentJob,
  {
    connection: redis,
    concurrency: CONCURRENCY,
  }
);

// ── Lifecycle events ───────────────────────────────────────────────────────

worker.on("ready", () => {
  console.log(
    `[worker] ready — listening on queue="${QUEUE_NAME}" concurrency=${CONCURRENCY}`
  );
});

worker.on("completed", (job) => {
  console.log(`[worker] ✓ job ${job.id} completed`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] ✗ job ${job?.id} failed:`, err.message);
});

worker.on("error", (err) => {
  console.error("[worker] error:", err.message);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────

async function shutdown(signal: string) {
  console.log(`[worker] received ${signal}, shutting down gracefully…`);
  await worker.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
