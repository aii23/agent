import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

function createRedisClient(): Redis {
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: false,
  });

  client.on("error", (err) => {
    console.error("[redis] connection error:", err.message);
  });

  client.on("connect", () => {
    console.log("[redis] connected");
  });

  return client;
}

// Singleton for app-wide use. Next.js hot reload creates new module instances
// in dev — the global trick keeps a single connection across reloads.
declare global {
  // eslint-disable-next-line no-var
  var __redis: Redis | undefined;
}

export const redis: Redis =
  globalThis.__redis ?? (globalThis.__redis = createRedisClient());

// Separate connection for BullMQ subscribers (Redis pub/sub requires a
// dedicated connection that can't run other commands while subscribed).
export function createSubscriberClient(): Redis {
  return new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

// Fail-fast connection for Queue producers (API layer).
// enableOfflineQueue: false ensures Queue.add() throws immediately when Redis
// is unavailable instead of silently buffering the command forever.
export function createQueueProducerClient(): Redis {
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableOfflineQueue: false,
    enableReadyCheck: false,
  });

  client.on("error", (err) => {
    console.error("[redis:queue-producer] connection error:", err.message);
  });

  return client;
}
