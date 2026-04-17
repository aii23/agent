/**
 * Agent Worker
 *
 * Picks up jobs from the `agent-queue` BullMQ queue and dispatches them
 * to the appropriate orchestrator handler based on job name.
 *
 * Run locally:   pnpm worker
 * Watch mode:    pnpm worker          (tsx watch — auto-restarts on code change)
 * Single run:    pnpm worker:once
 */

import { Worker, type Job } from "bullmq";
import { redis } from "../lib/redis";
import type { AgentJobData, AgentJobName } from "../lib/queue";
import type { ManagerPlanJobData, ExecutorRunJobData, ManagerSynthesizeJobData } from "../lib/queue";
import { handleManagerPlan } from "../orchestrator/plan";
import { handleExecutorRun } from "../orchestrator/execute";
import { handleManagerSynthesize } from "../orchestrator/synthesize";

// Load .env when running outside Next.js
import { config } from "dotenv";
config({ path: ".env.local" });

const QUEUE_NAME = "agent-queue";
const CONCURRENCY = 5;

// ── Job dispatcher ─────────────────────────────────────────────────────────

async function processAgentJob(
  job: Job<AgentJobData, void, AgentJobName>
): Promise<void> {
  console.log(`[worker] job ${job.id} — name="${job.name}"`);

  switch (job.name) {
    case "manager.plan":
      return handleManagerPlan(job.data as ManagerPlanJobData);

    case "executor.run":
      return handleExecutorRun(job.data as ExecutorRunJobData);

    case "manager.synthesize":
      return handleManagerSynthesize(job.data as ManagerSynthesizeJobData);

    default:
      throw new Error(`Unknown job name: ${job.name}`);
  }
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
  console.log(`[worker] ✓ job ${job.id} (${job.name}) completed`);
});

worker.on("failed", (job, err) => {
  console.error(`[worker] ✗ job ${job?.id} (${job?.name}) failed:`, err.message);
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
