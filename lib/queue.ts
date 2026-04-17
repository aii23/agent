import { Job, Queue, QueueEvents } from "bullmq";
import { redis, createQueueProducerClient } from "./redis";

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

// Fail-fast connection: throws immediately when Redis is unavailable so callers
// get an explicit error instead of a silently buffered command.
const queueProducerConnection = createQueueProducerClient();

export const agentQueue = new Queue<AgentJobData, void, AgentJobName>(
  "agent-queue",
  {
    connection: queueProducerConnection,
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

async function enqueueJob(
  name: AgentJobName,
  data: AgentJobData,
  jobId: string
): Promise<string> {
  let job: Job<AgentJobData, void, AgentJobName>;

  try {
    job = await agentQueue.add(name, data, { jobId });
  } catch (err) {
    throw new Error(
      `Failed to enqueue "${name}" job (jobId=${jobId}): ${(err as Error).message}`,
      { cause: err }
    );
  }

  if (!job.id) {
    throw new Error(
      `Enqueue "${name}" (jobId=${jobId}) returned no job ID — job may not have been added`
    );
  }

  return job.id;
}

export async function enqueueManagerPlan(
  data: ManagerPlanJobData
): Promise<string> {
  return enqueueJob(
    "manager.plan",
    data,
    `plan:${data.conversationId}:${data.messageId}`
  );
}

export async function enqueueExecutorRun(
  data: ExecutorRunJobData
): Promise<string> {
  return enqueueJob(
    "executor.run",
    data,
    `exec:${data.executionPlanId}:${data.stepIndex}`
  );
}

export async function enqueueManagerSynthesize(
  data: ManagerSynthesizeJobData
): Promise<string> {
  return enqueueJob(
    "manager.synthesize",
    data,
    `synth:${data.executionPlanId}`
  );
}
