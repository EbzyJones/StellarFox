/**
 * Async Job Queue — public facade
 *
 * The single entry point the rest of the app imports. Keeps the BullMQ internals
 * behind a small, stable surface:
 *
 *   initJobQueues()       — start workers + metrics + (optional) scheduler. Called
 *                            once at server boot. Idempotent; never throws (a queue
 *                            failure must not take the API down with it).
 *   shutdownJobQueues()   — graceful drain: stop accepting work, wait for in-flight
 *                            jobs, close queues + connections. Called on SIGTERM/SIGINT.
 *   enqueue(name, data)   — add a job, typed by name.
 *   getQueueStats(name)   — per-queue counts for the admin routes.
 *   queueManager          — full producer API (pause/resume/list/retry/remove).
 *   workerManager         — worker lifecycle (rarely needed outside the facade).
 */

import { logger } from '../utils/logger';
import { closeQueueConnections } from './connection';
import { registerBatchProcessor } from './handlers/batch.handler';
import { queueManager } from './registry';
import { registerScheduledJobs } from './scheduler';
import { type JobDataMap, type JobNameValue, type JobResult } from './types';
import { workerManager } from './workers';
import type { JobsOptions, Job } from 'bullmq';

let initialized = false;
let shuttingDown = false;

/**
 * Start the queue subsystem. Safe to call once at boot. Failures are logged but
 * never re-thrown: the API stays up even if Redis is briefly unavailable, and the
 * metrics poller / scheduler are simply skipped on that run.
 */
export async function initJobQueues(): Promise<void> {
  if (initialized) return;
  if (!queueManager.isEnabled()) {
    logger.info('Job queue disabled (JOB_QUEUE_ENABLED=false); init skipped');
    initialized = true;
    return;
  }

  try {
    // Warm up queues (create the Queue instances so the first enqueue isn't lazy).
    for (const name of queueManager.names()) {
      queueManager.getQueue(name);
    }
    workerManager.start();
    queueManager.startMetricsPoller();
    await registerScheduledJobs();
    initialized = true;
    logger.info({ queues: queueManager.names() }, 'Job queue subsystem initialized');
  } catch (err) {
    // Logged at error but swallowed: the server keeps serving requests; queue ops
    // will throw on use (enqueue -> "subsystem disabled"-style guard) rather than
    // crash here. The next process restart will retry init.
    logger.error({ err: (err as Error).message }, 'Job queue initialization failed');
    initialized = true; // avoid retry loops on repeated calls
  }
}

/**
 * Graceful shutdown. Order:
 *  1. Close workers — stop picking up new jobs and wait for in-flight ones to
 *     finish (see workers.ts). A job interrupted here is re-delivered by the
 *     stalled-job watchdog on the next healthy worker.
 *  2. Close queues (producer side) — no new jobs can be enqueued.
 *  3. Close the dedicated BullMQ Redis connections.
 * Idempotent; safe to call even if init never ran.
 */
export async function shutdownJobQueues(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down job queue subsystem');

  try {
    await workerManager.close();
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Error closing workers during shutdown');
  }
  try {
    await queueManager.close();
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Error closing queues during shutdown');
  }
  try {
    await closeQueueConnections();
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Error closing queue Redis connections');
  }
  initialized = false;
  shuttingDown = false;
  logger.info('Job queue subsystem shut down');
}

/** Enqueue a typed job. See registry.enqueue for option semantics. */
export async function enqueue<N extends JobNameValue>(
  name: N,
  data: JobDataMap[N],
  opts: JobsOptions = {},
): Promise<Job<JobDataMap[N], JobResult<N>>> {
  return queueManager.enqueue(name, data, opts);
}

/** Per-queue counts. Convenience wrapper over queueManager.getStats. */
export async function getQueueStats(name: JobNameValue) {
  return queueManager.getStats(name);
}

export { queueManager, workerManager, registerBatchProcessor };
export * from './types';
