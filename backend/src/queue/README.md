# Async Job Queue (BullMQ over Redis)

A durable, observable job queue for long-running operations, batch processing, and
scheduled tasks. Built on **BullMQ** (the maintained successor to Bull) over the
existing Redis instance.

## Why BullMQ and not RabbitMQ?

This service already depends on Redis (caching, rate limiting, distributed locks).
BullMQ *is* Bull (v5+) and gives us, on top of Redis we already run:

- **Durability** — jobs persist in Redis; a process crash does not lose them.
- **Retries** — exponential backoff with a configurable cap, per-queue defaults.
- **Priorities**, **delayed** jobs, **rate limiting**, and **repeatable** (cron) jobs.
- **Stalled-job detection** — workers that die mid-job are re-queued automatically.
- **Graceful shutdown** — workers drain in-flight jobs before exiting.

Adding RabbitMQ would mean a second broker, a new `amqplib` dependency, and a new
container in docker-compose — extra operational surface for no functional gain here.
If the workload ever needs cross-service fan-out with complex routing (topic
exchanges, many independent consumers), RabbitMQ is the right tool; for this service
the BullMQ-on-Redis path is simpler and reuses existing infra.

## Layout

```
src/queue/
  types.ts          JobName enum, typed data/result maps, queue definitions type
  connection.ts      Dedicated ioredis connection(s) for BullMQ (maxRetriesPerRequest: null)
  metrics.ts         Prometheus gauges/counters/histogram for queues
  registry.ts        QueueManager — producer: enqueue, stats, pause/resume, retry/remove
  workers.ts         WorkerManager — consumer: workers, event wiring, graceful close
  scheduler.ts       Repeatable (cron) job registration — opt-in
  handlers/          Per-job processors, grounded in real services:
    export.handler     Long-running large data exports
    email.handler      Single + bulk email send
    batch.handler      Generic batch processing with pluggable processors
    snapshot.handler   Scheduled: probability snapshots
    cleanup.handler    Scheduled: DB retention/cleanup tasks
    util.ts            withTimeout + bounded-concurrency map
    index.ts           JobName → processor map
  index.ts          Public facade: initJobQueues / shutdownJobQueues / enqueue / getQueueStats
```

The main entry point (`src/index.ts`) calls `initJobQueues()` after the server
starts and `shutdownJobQueues()` on SIGTERM/SIGINT as part of graceful shutdown.

## Quick start

```ts
import { enqueue, JobName } from '../queue';

// Long-running export off the request path
const job = await enqueue(JobName.Export, { type: 'trades', from: '2024-01-01', requestedBy: 'admin1' });
// job.id — poll via the admin routes for completion + the stashed payload

// Single email (retries on SMTP failure)
await enqueue(JobName.Email, { to: 'u@x.com', template: 'reset_password', data: { resetUrl: '...' } });

// Bulk email — failures are fanned back out as individual retryable email jobs
await enqueue(JobName.EmailBlast, { recipients: [{ to, template, data }, ...] });

// Batch processing — register a processor, then enqueue a batch
import { registerBatchProcessor } from '../queue';
registerBatchProcessor('normalize', async (payload) => { /* ... */ });
await enqueue(JobName.Batch, { items: [{ id: '1', payload }], processor: 'normalize' });
```

## Configuration (env)

| Var | Default | Purpose |
|-----|---------|---------|
| `JOB_QUEUE_ENABLED` | `true` | Master switch. When false, `enqueue` throws and workers don't start. |
| `JOB_QUEUE_CONCURRENCY` | `4` | Jobs a worker processes in parallel per queue. |
| `JOB_QUEUE_MAX_RETRIES` | `3` | Default retry attempts (added to the first try). |
| `JOB_QUEUE_BACKOFF_MS` | `2000` | Base delay for exponential backoff. |
| `JOB_QUEUE_REMOVE_ON_COMPLETE` | `100` | Keep N completed jobs per queue for inspection. |
| `JOB_QUEUE_REMOVE_ON_FAIL` | `500` | Keep N failed jobs per queue for inspection/replay. |
| `JOB_QUEUE_STALLED_INTERVAL_MS` | `30000` | How often BullMQ scans for dead workers. |
| `JOB_QUEUE_MAX_STALLED_COUNT` | `1` | Times a job may stall before being failed. |
| `JOB_QUEUE_MAX_ACTIVE` | `0` | Per-second rate cap (0 = unlimited). |
| `JOB_QUEUE_METRICS_ENABLED` | `true` | Emit Prometheus metrics. |
| `JOB_QUEUE_SCHEDULER_ENABLED` | `false` | Register BullMQ repeatable (cron) jobs. |

## Scheduled tasks: migrating from node-cron

The same snapshot/cleanup tasks today run via `node-cron` in `cron/*.cron.ts`.
BullMQ repeatable jobs make them durable and observable, but the two must not run the
same task at once. To migrate a task:

1. Stop the node-cron fire, e.g. `PROBABILITY_SNAPSHOT_CRON_DISABLED=true` and
   `CLEANUP_CRON_DISABLED=true`.
2. Enable the queue scheduler: `JOB_QUEUE_SCHEDULER_ENABLED=true`.

`registerScheduledJobs()` is idempotent across restarts (BullMQ dedupes repeatable
schedules by `pattern + jobId`), so it is safe to call on every boot.

## Admin / observability routes

Mounted at `/api/admin/queues` (admin JWT required):

| Method | Path | Action |
|--------|------|--------|
| GET | `/` | Overview of all queues + counts. |
| GET | `/:name/stats` | Per-queue counts + paused flag. |
| GET | `/:name/jobs` | List jobs (`?status=&start=&end=`). |
| GET | `/:name/jobs/:id` | Job detail (data, result, attempts, stacktrace). |
| POST | `/:name/jobs/:id/retry` | Re-queue a failed job. |
| DELETE | `/:name/jobs/:id` | Remove a job. |
| POST | `/:name/pause` | Pause a queue (in-flight jobs finish). |
| POST | `/:name/resume` | Resume a queue. |
| GET | `/:name/jobs/:id/export` | Fetch a completed export job's stashed payload. |

Queue metrics are exposed at `GET /metrics` (`queue_jobs_completed_total`,
`queue_jobs_failed_total`, `queue_jobs_stalled_total`, `queue_job_duration_seconds`,
`queue_depth`, `queue_paused`).

## Failure handling

- A job that throws is retried up to `attempts` with exponential backoff.
- After retries are exhausted the job stays in the **failed** set (capped by
  `JOB_QUEUE_REMOVE_ON_FAIL`) and is replayable via the admin route or
  `queueManager.retryJob()`.
- A worker that dies mid-job leaves a **stalled** job; the watchdog re-queues it
  (up to `JOB_QUEUE_MAX_STALLED_COUNT` times) before failing it.

## Graceful shutdown

`shutdownJobQueues()` runs on SIGTERM/SIGINT: it closes workers (which wait for
in-flight jobs to finish), then closes the queues and the dedicated Redis
connections. The whole process shutdown is bounded by `SHUTDOWN_TIMEOUT_MS`
(default 30s) so a stuck dependency cannot hang a rolling deploy.

## Testing

Unit tests in `tests/queue/` mock BullMQ's `Queue`/`Worker` (as an EventEmitter for
the worker) and the surrounding Redis/env/metrics modules, so no real Redis or
Prometheus registry is needed: `npm --prefix backend run test:unit -- tests/queue`.
