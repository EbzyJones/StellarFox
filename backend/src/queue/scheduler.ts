/**
 * Async Job Queue — Scheduler (scheduled/repeatable tasks)
 *
 * Registers BullMQ repeatable jobs: durable, observable replacements for the
 * node-cron fires in cron/*.cron.ts. BullMQ stores the repeat schedule in Redis, so
 * a process restart does not lose the schedule, and only one worker instance runs
 * each fire (BullMQ guarantees a single claim per job). Each registration carries a
 * stable `jobId` so re-running registration on every boot is idempotent: BullMQ will
 * not create duplicate repeatable entries for the same key.
 *
 * Disabled by default (JOB_QUEUE_SCHEDULER_ENABLED) to avoid double-running while
 * the node-cron jobs are still active. Migration steps are in queue/README.md.
 */

import { logger } from '../utils/logger';
import { getEnv } from '../config/env';
import { queueManager } from './registry';
import { JobName, type CleanupJobData, type JobDataMap, type JobNameValue } from './types';

interface ScheduledJob<N extends JobNameValue> {
  queue: N;
  /** BullMQ cron pattern (5-field, like node-cron). */
  pattern: string;
  /** Stable id so repeated registration is idempotent. */
  jobId: string;
  data: JobDataMap[N];
  description: string;
}

const SCHEDULED_JOBS: ScheduledJob<JobNameValue>[] = [
  // Snapshot — every minute, matching cron/probabilitySnapshot.cron.ts.
  {
    queue: JobName.Snapshot,
    pattern: '* * * * *',
    jobId: 'snapshot:probability',
    data: {},
    description: 'Record probability snapshots every minute',
  },
  // Cleanup tasks — schedules match cron/cleanup.cron.ts.
  {
    queue: JobName.Cleanup,
    pattern: '0 * * * *',
    jobId: 'cleanup:sessions',
    data: { task: 'sessions' } satisfies CleanupJobData,
    description: 'Delete expired sessions (hourly)',
  },
  {
    queue: JobName.Cleanup,
    pattern: '0 * * * *',
    jobId: 'cleanup:resetTokens',
    data: { task: 'resetTokens' } satisfies CleanupJobData,
    description: 'Delete expired reset tokens (hourly)',
  },
  {
    queue: JobName.Cleanup,
    pattern: '0 * * * *',
    jobId: 'cleanup:predictions',
    data: { task: 'predictions' } satisfies CleanupJobData,
    description: 'Delete expired predictions (hourly)',
  },
  {
    queue: JobName.Cleanup,
    pattern: '0 2 * * *',
    jobId: 'cleanup:notifications',
    data: { task: 'notifications' } satisfies CleanupJobData,
    description: 'Soft-delete old notifications (daily 02:00)',
  },
  {
    queue: JobName.Cleanup,
    pattern: '0 3 * * 0',
    jobId: 'cleanup:distributions',
    data: { task: 'distributions' } satisfies CleanupJobData,
    description: 'Archive failed distributions (weekly Sun 03:00)',
  },
  {
    queue: JobName.Cleanup,
    pattern: '0 4 * * *',
    jobId: 'cleanup:blockchainEvents',
    data: { task: 'blockchainEvents' } satisfies CleanupJobData,
    description: 'Delete old blockchain_events (daily 04:00)',
  },
];

let registered = false;

/**
 * Register all repeatable jobs. Idempotent across calls and across restarts:
 * BullMQ dedupes repeatable schedules by (pattern, jobId). No-op when the
 * scheduler is disabled or the subsystem is off.
 */
export async function registerScheduledJobs(): Promise<void> {
  if (registered) return;
  if (!queueManager.isEnabled()) {
    logger.info('Job queue disabled; scheduled jobs not registered');
    return;
  }
  if (!getEnv().JOB_QUEUE_SCHEDULER_ENABLED) {
    logger.info('Job queue scheduler disabled (JOB_QUEUE_SCHEDULER_ENABLED=false); keeping node-cron as source of truth');
    return;
  }

  for (const job of SCHEDULED_JOBS) {
    try {
      const queue = queueManager.getQueue(job.queue);
      await queue.add(job.queue, job.data as unknown, {
        // jobId makes the repeatable key stable so re-registration doesn't duplicate.
        jobId: job.jobId,
        repeat: { pattern: job.pattern },
        ...queueManager.definition(job.queue).defaultJobOptions,
      });
      logger.info({ queue: job.queue, jobId: job.jobId, pattern: job.pattern }, 'Scheduled job registered');
    } catch (err) {
      logger.error(
        { queue: job.queue, jobId: job.jobId, err: (err as Error).message },
        'Failed to register scheduled job',
      );
    }
  }
  registered = true;
  logger.info({ count: SCHEDULED_JOBS.length }, 'All scheduled jobs registered');
}

/** Clear the "registered" flag so tests can re-run registration. */
export function resetSchedulerState(): void {
  registered = false;
}

export { SCHEDULED_JOBS };
