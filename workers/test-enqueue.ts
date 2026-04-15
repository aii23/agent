/**
 * Smoke test: enqueues a single test job so you can verify the worker picks it up.
 *
 * Usage:
 *   # Terminal 1 — start worker
 *   pnpm worker
 *
 *   # Terminal 2 — fire test job
 *   tsx workers/test-enqueue.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { enqueueAgentRun } from "../lib/queue";
import { redis } from "../lib/redis";

async function main() {
  const jobId = await enqueueAgentRun({
    runId: `test-run-${Date.now()}`,
    conversationId: "test-conversation",
    messageId: "test-message",
    agentSlug: "ceo",
    userMessage: "What should our Q3 priorities be?",
    mode: "inline",
  });

  console.log(`[test] enqueued job ${jobId} — check worker output`);
  await redis.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
