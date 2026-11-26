/**
 * Async Job Queue — QueueManager (producer side)
 *
 * Owns BullMQ `Queue` instances keyed by job name and exposes a small, typed API
 * used by the rest of the app:
 *   - enqueue(): add a job (typed data + result)
 *   - getStats(): aggregate counts for the admin routes
 *   - getJobs()/getJob()/retryJob()/removeJob(): inspection + operations
 *   - pause()/resume(): backpressure / maintenance switches
 *
 * Lifecycle is managed by the public facade in `queue/index.ts`:
 * `initJobQueues()` lazily creates queues on first use and starts the metrics
 * poller; `shutdownJobQueues()` closes everything.
 */

import { Queue, type Job, type JobsOptions } from 'bullmq';
import { getEnv } from '../config/env';
import { logger } from '../utils/logger';
import { getQueueConnection } from './connection';
import {
  JobName,
  type JobData,
  type JobDataMap,
  type JobNameValue,
  type JobResult,
  type QueueDefinition,
  type QueueStats,
} from './types';
import { queueDepth, queuePaused } from './metrics';

// ---------------------------------------------------------------------------
// Queue definitions — defaults derived from validated env
// ---------------------------------------------------------------------------

function baseDefaults(): JobsOptions {
  const env = getEnv();
  return {
    attempts: env.JOB_QUEUE_MAX_RETRIES + 1, // attempts includes the first try
    backoff: {
      type: 'exponential',
      delay: env.JOB_QUEUE_BACKOFF_MS,
    },
    removeOnComplete: env.JOB_QUEUE_REMOVE_ON_COMPLETE,
    removeOnFail: env.JOB_QUEUE_REMOVE_ON_FAIL,
  };
}

/**
 * The canonical set of queues. Long-running jobs get fewer attempts and longer
 * backoff; transactional emails get more attempts (SMTP hiccups are transient and
 * cheap to retry); scheduled jobs run again on their own schedule, so one failure
 * is not worth aggressive retries.
 */
export const QUEUE_DEFINITIONS: QueueDefinition[] = [
  {
    name: JobName.Export,
    description: 'Long-running large data exports (trades, user data)',
    defaultJobOptions: {
      ...baseDefaults(),
      attempts: 2, // exports are expensive; a retry is a full re-run
      priority: 6,
    },
  },
  {
    name: JobName.Email,
    description: 'Single transactional email send',
    defaultJobOptions: {
      ...baseDefaults(),
      attempts: 6, // SMTP blips are common and cheap to retry
      priority: 3,
    },
  },
  {
    name: JobName.EmailBlast,
    description: 'Bulk email send with per-recipient progress',
    defaultJobOptions: {
      ...baseDefaults(),
      attempts: 3,
      priority: 8,
    },
  },
  {
    name: JobName.Batch,
    description: 'Generic batch processing of typed items',
    defaultJobOptions: {
      ...baseDefaults(),
      attempts: 3,
      priority: 5,
    },
  },
  {
    name: JobName.Snapshot,
    description: 'Scheduled: record market probability snapshots',
    defaultJobOptions: {
      ...baseDefaults(),
      attempts: 2,
    },
  },
  {
    name: JobName.Cleanup,
    description: 'Scheduled: database retention / cleanup tasks',
    defaultJobOptions: {
      ...baseDefaults(),
      attempts: 2,
    },
  },
];

const DEFINITIONS_BY_NAME = new Map(QUEUE_DEFINITIONS.map((d) => [d.name, d]));

// ---------------------------------------------------------------------------
// QueueManager
// ---------------------------------------------------------------------------

class QueueManager {
  private queues = new Map<JobNameValue, Queue>();
  private pollHandle: ReturnType<typeof setInterval> | null = null;

  /** True if the subsystem is enabled (env JOB_QUEUE_ENABLED). */
  isEnabled(): boolean {
    return getEnv().JOB_QUEUE_ENABLED;
  }

  /** All queue names, in definition order — used by the admin overview. */
  names(): JobNameValue[] {
    return QUEUE_DEFINITIONS.map((d) => d.name);
  }

  definition(name: JobNameValue): QueueDefinition {
    const def = DEFINITIONS_BY_NAME.get(name);
    if (!def) throw new Error(`Unknown queue: ${name}`);
    return def;
  }

  /** Lazily create (or return cached) the BullMQ queue for a name. */
  getQueue(name: JobNameValue): Queue {
    const existing = this.queues.get(name);
    if (existing) return existing;

    if (!this.isEnabled()) {
      throw new Error(
        `Job queue subsystem is disabled (JOB_QUEUE_ENABLED=false); cannot use queue "${name}"`,
      );
    }

    const def = this.definition(name);
    const queue = new Queue(name, {
      connection: getQueueConnection('queue'),
      defaultJobOptions: def.defaultJobOptions,
    });
    this.queues.set(name, queue);
    logger.debug({ queue: name }, 'Queue created');
    return queue;
  }

  /** Whether a queue has been instantiated yet. */
  has(name: JobNameValue): boolean {
    return this.queues.has(name);
  }

  /**
   * Enqueue a job. Caller-supplied options are merged over the queue defaults, so
   * callers can override priority/attempts/delay per job without touching defaults.
   */
  async enqueue<N extends JobNameValue>(
    name: N,
    data: JobDataMap[N],
    opts: JobsOptions = {},
  ): Promise<Job<JobData<N>, JobResult<N>>> {
    const queue = this.getQueue(name);
    const merged: JobsOptions = {
      ...this.definition(name).defaultJobOptions,
      ...opts,
    };
    const job = await queue.add(name, data as unknown, merged);
    logger.info(
      { queue: name, jobId: job.id, opts: { priority: merged.priority, attempts: merged.attempts } },
      'Job enqueued',
    );
    return job as unknown as Job<JobData<N>, JobResult<N>>;
  }

  /** Aggregate counts for a queue, plus paused flag. */
  async getStats(name: JobNameValue): Promise<QueueStats> {
    const queue = this.getQueue(name);
    const counts = await queue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
    );
    return {
      name,
      waiting: counts.waiting,
      active: counts.active,
      completed: counts.completed,
      failed: counts.failed,
      delayed: counts.delayed,
      paused: await queue.isPaused(),
    };
  }

  /** Overview of all queues, even ones not yet instantiated. */
  async getAllStats(): Promise<QueueStats[]> {
    const stats: QueueStats[] = [];
    for (const name of this.names()) {
      if (this.has(name)) {
        stats.push(await this.getStats(name));
      } else {
        // Uninstantiated queue: report zeros. Still reflects paused=false.
        stats.push({
          name,
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
          paused: false,
        });
      }
    }
    return stats;
  }

  /** List jobs by status with pagination. `types` defaults to all active states. */
  async getJobs(
    name: JobNameValue,
    opts: { start?: number; end?: number; types?: string[] } = {},
  ): Promise<Job[]> {
    const queue = this.getQueue(name);
    const { start = 0, end = 49, types } = opts;
    return queue.getJobs(types, start, end);
  }

  /** Fetch a single job by id. */
  async getJob(name: JobNameValue, id: string): Promise<Job | undefined> {
    const queue = this.getQueue(name);
    return queue.getJob(id);
  }

  /** Move a failed job back to the waiting set for another attempt. */
  async retryJob(name: JobNameValue, id: string): Promise<void> {
    const job = await this.getJob(name, id);
    if (!job) throw new Error(`Job ${id} not found in queue ${name}`);
    await job.retry();
    logger.info({ queue: name, jobId: id }, 'Job retried');
  }

  /** Remove a job from the queue (waiting/active/completed/failed). */
  async removeJob(name: JobNameValue, id: string): Promise<void> {
    const job = await this.getJob(name, id);
    if (!job) throw new Error(`Job ${id} not found in queue ${name}`);
    await job.remove();
    logger.info({ queue: name, jobId: id }, 'Job removed');
  }

  /** Pause a queue: in-flight jobs finish, new ones wait. */
  async pause(name: JobNameValue): Promise<void> {
    const queue = this.getQueue(name);
    await queue.pause();
    queuePaused.set({ queue: name }, 1);
    logger.info({ queue: name }, 'Queue paused');
  }

  /** Resume a paused queue. */
  async resume(name: JobNameValue): Promise<void> {
    const queue = this.getQueue(name);
    await queue.resume();
    queuePaused.set({ queue: name }, 0);
    logger.info({ queue: name }, 'Queue resumed');
  }

  /**
   * Start a poller that refreshes the `queue_depth` / `queue_paused` gauges for the
   * Prometheus endpoint. Running it from the producer side keeps metrics accurate
   * even on instances that only produce jobs (no workers). Interval is fixed and
   * modest to keep Redis load low.
   */
  startMetricsPoller(intervalMs = 15_000): void {
    if (!getEnv().JOB_QUEUE_METRICS_ENABLED) return;
    if (this.pollHandle) return;
    this.pollHandle = setInterval(() => {
      void this.refreshMetrics().catch((err) => {
        logger.debug({ err: (err as Error).message }, 'Queue metrics poll failed');
      });
    }, intervalMs);
    // Don't keep the process alive solely for this timer.
    this.pollHandle.unref?.();
    // Seed metrics immediately rather than waiting for the first tick.
    void this.refreshMetrics().catch(() => undefined);
  }

  private async refreshMetrics(): Promise<void> {
    for (const name of this.queues.keys()) {
      const stats = await this.getStats(name);
      queueDepth.set({ queue: name, state: 'waiting' }, stats.waiting);
      queueDepth.set({ queue: name, state: 'active' }, stats.active);
      queueDepth.set({ queue: name, state: 'completed' }, stats.completed);
      queueDepth.set({ queue: name, state: 'failed' }, stats.failed);
      queueDepth.set({ queue: name, state: 'delayed' }, stats.delayed);
      queuePaused.set({ queue: name }, stats.paused ? 1 : 0);
    }
  }

  /** Stop the metrics poller. Idempotent. */
  stopMetricsPoller(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  /**
   * Close all queues (producer side). Does not touch workers. Idempotent.
   */
  async close(): Promise<void> {
    this.stopMetricsPoller();
    const closing: Promise<unknown>[] = [];
    for (const queue of this.queues.values()) {
      closing.push(queue.close().catch((err) => {
        logger.warn({ err: (err as Error).message }, 'Error closing queue');
      }));
    }
    await Promise.all(closing);
    this.queues.clear();
  }
}

export const queueManager = new QueueManager();
