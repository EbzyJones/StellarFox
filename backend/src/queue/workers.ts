/**
 * Async Job Queue — WorkerManager (consumer side)
 *
 * Creates one BullMQ `Worker` per queue, binds each to its handler, and wires the
 * BullMQ lifecycle events (completed/failed/stalled/error) to the logger and the
 * Prometheus metrics defined in queue/metrics.ts. Worker concurrency, the rate
 * limiter, and the stalled-job watchdog are all derived from validated env so a
 * single config source drives runtime behaviour.
 *
 * Graceful shutdown is the robustness-critical part: `close()` tells each worker
 * to stop picking up new jobs and waits for in-flight ones to finish (BullMQ
 * `worker.close(true)`). The public facade calls this on SIGTERM/SIGINT so deploys
 * never drop an in-progress job (BullMQ will re-deliver it after the stalled
 * interval on the next healthy worker).
 */

import { Worker } from 'bullmq';
import { getEnv } from '../config/env';
import { logger } from '../utils/logger';
import { getQueueConnection } from './connection';
import { HANDLERS } from './handlers';
import { queueJobDuration, queueJobsCompleted, queueJobsFailed, queueJobsStalled } from './metrics';
import { QUEUE_DEFINITIONS, queueManager } from './registry';
import { type JobNameValue } from './types';

class WorkerManager {
  private workers = new Map<JobNameValue, Worker>();

  /** Start a worker for every defined queue. Idempotent — skips already-started queues. */
  start(): void {
    if (!queueManager.isEnabled()) {
      logger.info('Job queue disabled (JOB_QUEUE_ENABLED=false); workers not started');
      return;
    }
    const env = getEnv();

    for (const def of QUEUE_DEFINITIONS) {
      if (this.workers.has(def.name)) continue;

      const handler = HANDLERS[def.name];
      const worker = new Worker(
        def.name,
        async (job) => {
          const started = Date.now();
          try {
            const result = await handler(job as never);
            return result as unknown;
          } finally {
            queueJobDuration
              .labels(def.name, job.name as string)
              .observe((Date.now() - started) / 1000);
          }
        },
        {
          connection: getQueueConnection('worker'),
          concurrency: env.JOB_QUEUE_CONCURRENCY,
          // Stalled-job watchdog: how often to scan for workers that vanished mid-job.
          settings: {
            stalledInterval: env.JOB_QUEUE_STALLED_INTERVAL_MS,
            maxStalledCount: env.JOB_QUEUE_MAX_STALLED_COUNT,
          },
          // Optional per-second rate cap (e.g. throttle SMTP on the email queue).
          ...(env.JOB_QUEUE_MAX_ACTIVE > 0
            ? { limiter: { max: env.JOB_QUEUE_MAX_ACTIVE, duration: 1000 } }
            : {}),
        },
      );

      worker.on('completed', (job) => {
        queueJobsCompleted.inc({ queue: def.name, job: job.name as string });
        logger.debug({ queue: def.name, jobId: job.id }, 'Job completed');
      });

      worker.on('failed', (job, err) => {
        if (!job) return; // can be null if the job was removed before processing
        const attemptsMade = job.attemptsMade;
        const maxAttempts = (job.opts.attempts ?? 1);
        queueJobsFailed.inc({ queue: def.name, job: job.name as string });
        if (attemptsMade >= maxAttempts) {
          logger.error(
            { queue: def.name, jobId: job.id, jobName: job.name, attemptsMade, err: err.message },
            'Job failed permanently (retries exhausted)',
          );
        } else {
          logger.warn(
            { queue: def.name, jobId: job.id, jobName: job.name, attemptsMade, err: err.message },
            'Job failed (will retry)',
          );
        }
      });

      worker.on('stalled', (jobId) => {
        // 'stalled' fires when a worker died holding the job; it is being re-processed.
        queueJobsStalled.inc({ queue: def.name, job: def.name });
        logger.warn({ queue: def.name, jobId }, 'Job stalled and will be re-processed');
      });

      worker.on('error', (err) => {
        // BullMQ emits connection-level errors here; redis blips are routine.
        logger.error({ queue: def.name, err: err.message }, 'Worker error');
      });

      this.workers.set(def.name, worker);
      logger.info(
        { queue: def.name, concurrency: env.JOB_QUEUE_CONCURRENCY, description: def.description },
        'Worker started',
      );
    }
  }

  /** Whether a worker is running for a queue. */
  has(name: JobNameValue): boolean {
    return this.workers.has(name);
  }

  /**
   * Gracefully stop every worker and wait for in-flight jobs to finish. Idempotent.
   * `Worker#close(true)` (doNotWaitActive=false) waits for active jobs before closing.
   */
  async close(): Promise<void> {
    const closing: Promise<unknown>[] = [];
    for (const [name, worker] of this.workers) {
      closing.push(
        worker.close().catch((err) => {
          logger.warn({ queue: name, err: (err as Error).message }, 'Error closing worker');
        }),
      );
    }
    await Promise.all(closing);
    this.workers.clear();
    logger.info('All queue workers closed');
  }
}

export const workerManager = new WorkerManager();
