/**
 * Async Job Queue — Redis connection factory for BullMQ
 *
 * BullMQ issues commands that block the connection (BRPOPLPUSH and friends), so it
 * REQUIRES `maxRetriesPerRequest: null`. The existing `config/redis.ts` singleton is
 * shared across the app and uses the ioredis default (`maxRetriesPerRequest: 20`),
 * which would make BullMQ throw. We therefore hand BullMQ its own connections.
 *
 * BullMQ also recommends a separate connection per role (queue producer, worker,
 * queue-events listener) so a long-running blocking command on one role cannot
 * starve commands on another. This factory produces a dedicated connection per
 * role and caches it so repeated callers reuse the same instance.
 */

import IORedis from 'ioredis';
import { logger } from '../utils/logger';

export type QueueConnectionRole = 'queue' | 'worker' | 'events';

const connections = new Map<QueueConnectionRole, IORedis>();

function resolveUrl(): string {
  return process.env.REDIS_URL ?? 'redis://localhost:6379';
}

/**
 * Returns a BullMQ-compatible ioredis connection for the given role. The first
 * caller for a role creates the connection; subsequent callers reuse it. Callers
 * should NOT close the returned connection — `shutdownJobQueues()` owns that.
 */
export function getQueueConnection(role: QueueConnectionRole): IORedis {
  const existing = connections.get(role);
  if (existing) return existing;

  const conn = new IORedis(resolveUrl(), {
    // BullMQ hard requirement: it uses blocking commands, so it must be allowed to
    // retry indefinitely rather than failing a queued request after N attempts.
    maxRetriesPerRequest: null,
    // BullMQ does its own readiness checks; skip ioredis's to avoid races at startup.
    enableReadyCheck: false,
    // Reconnect with capped exponential backoff so a Redis blip doesn't hammer it.
    retryStrategy: (times) => Math.min(times * 500, 10_000),
  });

  conn.on('error', (err) => {
    // Logged at warn: Redis reconnects are routine; a hard failure surfaces via the
    // queue/worker error events which the managers already wire to the logger.
    logger.warn({ role, err: err.message }, 'Queue Redis connection error');
  });

  connections.set(role, conn);
  logger.debug({ role }, 'Queue Redis connection created');
  return conn;
}

/**
 * Close every cached queue connection. Called during graceful shutdown. Idempotent.
 * Uses `quit()` for a clean disconnect (sends pending commands then closes).
 */
export async function closeQueueConnections(): Promise<void> {
  const pending: Promise<unknown>[] = [];
  for (const [role, conn] of connections) {
    pending.push(
      conn.quit().catch((err) => {
        logger.warn({ role, err: (err as Error).message }, 'Error closing queue Redis connection');
      }),
    );
  }
  await Promise.all(pending);
  connections.clear();
}
