import { Queue, QueueEvents } from "bullmq";
import { redis } from "./redis";

// ── Job payload types ──────────────────────────────────────────────────────

export interface AgentJobData {
  runId: string;
  conversationId: string;
  messageId: string;
  agentSlug: string;
  userMessage: string;
  /** "inline" = single agent turn, "workflow" = multi-step orchestration */
  mode: "inline" | "workflow";
  workflowId?: string;
}

export type AgentJobName = "agent.run";

// ── Queue ──────────────────────────────────────────────────────────────────

export const agentQueue = new Queue<AgentJobData, void, AgentJobName>(
  "agent-queue",
  {
    connection: redis,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 2_000,
      },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
    },
  }
);

// ── Queue events (for monitoring / metrics) ────────────────────────────────

export const agentQueueEvents = new QueueEvents("agent-queue", {
  connection: redis,
});

// ── Helper: enqueue a job ──────────────────────────────────────────────────

export async function enqueueAgentRun(
  data: AgentJobData
): Promise<string> {
  const job = await agentQueue.add("agent.run", data, {
    jobId: `run:${data.runId}`, // idempotent — safe to enqueue twice
  });
  return job.id!;
}
