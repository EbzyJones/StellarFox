/**
 * Async Job Queue — Prometheus metrics
 *
 * Registered on the global prom-client registry (see services/metrics.service.ts),
 * so they are exposed at GET /metrics alongside the HTTP/DB/cron metrics. Gauge
 * counts are refreshed by the WorkerManager on the BullMQ 'completed'/'failed'
 * events and periodically by a polling loop; counters are incremented on the same
 * events. Keep label cardinality low: `queue` and `job` (job name) only.
 */

import { Counter, Gauge, Histogram } from 'prom-client';

/** Total jobs that finished successfully, by queue and job name. */
export const queueJobsCompleted = new Counter({
  name: 'queue_jobs_completed_total',
  help: 'Total jobs completed successfully',
  labelNames: ['queue', 'job'] as const,
});

/** Total jobs that failed permanently, by queue and job name. */
export const queueJobsFailed = new Counter({
  name: 'queue_jobs_failed_total',
  help: 'Total jobs that failed (exhausted retries or marked failed)',
  labelNames: ['queue', 'job'] as const,
});

/** Total jobs that stalled (worker died mid-job), by queue. */
export const queueJobsStalled = new Counter({
  name: 'queue_jobs_stalled_total',
  help: 'Total jobs detected as stalled',
  labelNames: ['queue', 'job'] as const,
});

/** Job processing duration in seconds, by queue and job name. */
export const queueJobDuration = new Histogram({
  name: 'queue_job_duration_seconds',
  help: 'Duration of job processing in seconds',
  labelNames: ['queue', 'job'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60, 120, 300] as const,
});

/** Current number of jobs in each queue state, by queue. `state` is the label. */
export const queueDepth = new Gauge({
  name: 'queue_depth',
  help: 'Number of jobs in a queue state',
  labelNames: ['queue', 'state'] as const,
});

/** Whether a queue is paused (1) or running (0). */
export const queuePaused = new Gauge({
  name: 'queue_paused',
  help: '1 if the queue is paused, 0 if it is running',
  labelNames: ['queue'] as const,
});
