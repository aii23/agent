import { Queue, QueueEvents } from "bullmq";
import { redis } from "./redis";

// ── Job payload types ──────────────────────────────────────────────────────

/** Triggered by conversations.addMessage when a user sends a message. */
export interface ManagerPlanJobData {
  conversationId: string;
  messageId: string; // the user Message that triggered this run
  agentSlug: string; // which manager agent to use
}

/** Triggered by manager.plan (step 0) or executor.run (subsequent steps). */
export interface ExecutorRunJobData {
  executionPlanId: string;
  stepIndex: number;
}

/** Triggered by executor.run after the final step completes. */
export interface ManagerSynthesizeJobData {
  executionPlanId: string;
}

export type AgentJobName =
  | "manager.plan"
  | "executor.run"
  | "manager.synthesize";

export type AgentJobData =
  | ManagerPlanJobData
  | ExecutorRunJobData
  | ManagerSynthesizeJobData;

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

// ── Enqueue helpers ────────────────────────────────────────────────────────

export async function enqueueManagerPlan(
  data: ManagerPlanJobData
): Promise<string> {
  const job = await agentQueue.add("manager.plan", data, {
    jobId: `plan:${data.conversationId}:${data.messageId}`,
  });
  return job.id!;
}

export async function enqueueExecutorRun(
  data: ExecutorRunJobData
): Promise<string> {
  const job = await agentQueue.add("executor.run", data, {
    jobId: `exec:${data.executionPlanId}:${data.stepIndex}`,
  });
  return job.id!;
}

export async function enqueueManagerSynthesize(
  data: ManagerSynthesizeJobData
): Promise<string> {
  const job = await agentQueue.add("manager.synthesize", data, {
    jobId: `synth:${data.executionPlanId}`,
  });
  return job.id!;
}
