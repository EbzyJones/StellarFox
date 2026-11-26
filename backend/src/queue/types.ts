/**
 * Async Job Queue — shared types
 *
 * The queue subsystem is built on BullMQ (the maintained successor to Bull) over
 * the existing Redis instance. These types form the contract between producers
 * (callers of `enqueue`), the worker manager, and the admin/observability routes.
 *
 * Every job name has a strongly-typed data payload and result so producers and
 * handlers stay in sync at compile time via the `JobDataMap` / `JobResultMap`
 * lookups below.
 */

import type { JobsOptions } from 'bullmq';

/**
 * Logical queue names. Each maps to a Redis-backed BullMQ queue. Names are also
 * used as Prometheus metric labels and admin-route path segments, so they must be
 * URL-safe and stable.
 */
export const JobName = {
  /** Long-running: build a large data export (trades or user data) off the request path. */
  Export: 'export',
  /** Long-running: send a single transactional email. */
  Email: 'email',
  /** Long-running/blast: send many emails, reporting per-recipient progress. */
  EmailBlast: 'email-blast',
  /** Batch processing: process a list of typed items with bounded concurrency. */
  Batch: 'batch',
  /** Scheduled: record market probability snapshots (replaces the node-cron fire). */
  Snapshot: 'snapshot',
  /** Scheduled: run DB cleanup tasks (replaces the cleanup node-cron fires). */
  Cleanup: 'cleanup',
} as const;

export type JobNameValue = (typeof JobName)[keyof typeof JobName];

/** Job priority, mirroring BullMQ's convention where lower numbers run first. */
export const JobPriority = {
  Low: 10,
  Normal: 5,
  High: 1,
  Critical: 0,
} as const;

// ---------------------------------------------------------------------------
// Per-job data + result contracts
// ---------------------------------------------------------------------------

export interface ExportJobData {
  /** Which export builder to run. */
  type: 'trades' | 'userData';
  /** Optional date range (ISO strings) for the trades export. */
  from?: string;
  to?: string;
  /** User id the export concerns (required for userData). */
  userId?: string;
  /** Admin id that requested the export, for audit logging. */
  requestedBy?: string;
}

export interface ExportJobResult {
  type: ExportJobData['type'];
  /** Number of data rows produced. */
  rows: number;
  /** Bytes of the serialized output. */
  bytes: number;
  /** Where the result was written (object key / path / inline marker). */
  location: string;
  durationMs: number;
}

export interface EmailJobData {
  to: string;
  template: string;
  data: Record<string, string>;
}

export interface EmailBlastJobData {
  recipients: EmailJobData[];
}

export interface EmailBlastJobResult {
  sent: number;
  failed: number;
}

export interface BatchItem {
  id: string;
  payload: unknown;
}

export interface BatchJobData {
  /** Items to process in this batch job. */
  items: BatchItem[];
  /**
   * Logical processor key. Handlers dispatch on this so the same queue can run
   * different batch strategies without a new queue per strategy.
   */
  processor: string;
}

export interface BatchJobResult {
  processed: number;
  succeeded: number;
  failed: number;
  /** Ids of items that failed after all retries. */
  failedIds: string[];
}

/** Scheduled jobs carry only a marker; their handler knows what to do. */
export interface SnapshotJobData {
  /** ISO timestamp the run was scheduled for, for idempotency/diagnostics. */
  scheduledFor?: string;
}

export interface CleanupJobData {
  /** Which cleanup task to run. */
  task: 'sessions' | 'resetTokens' | 'predictions' | 'notifications' | 'distributions' | 'blockchainEvents';
  scheduledFor?: string;
}

export interface CleanupJobResult {
  task: CleanupJobData['task'];
  deleted: number;
}

/** Compile-time map: job name -> data payload. */
export interface JobDataMap {
  [JobName.Export]: ExportJobData;
  [JobName.Email]: EmailJobData;
  [JobName.EmailBlast]: EmailBlastJobData;
  [JobName.Batch]: BatchJobData;
  [JobName.Snapshot]: SnapshotJobData;
  [JobName.Cleanup]: CleanupJobData;
}

/** Compile-time map: job name -> result payload. */
export interface JobResultMap {
  [JobName.Export]: ExportJobResult;
  [JobName.Email]: void;
  [JobName.EmailBlast]: EmailBlastJobResult;
  [JobName.Batch]: BatchJobResult;
  [JobName.Snapshot]: { recorded: number };
  [JobName.Cleanup]: CleanupJobResult;
}

/** Per-job data inferred from a job name. */
export type JobData<N extends JobNameValue> = JobDataMap[N];
/** Per-job result inferred from a job name. */
export type JobResult<N extends JobNameValue> = JobResultMap[N];

/**
 * Canonical queue definitions. Drives queue creation, worker assignment, and the
 * admin overview. `defaultJobOptions` are merged with per-enqueue overrides.
 */
export interface QueueDefinition {
  name: JobNameValue;
  /** Human-readable description shown by the admin routes. */
  description: string;
  /** Default options applied to every job added to this queue. */
  defaultJobOptions: JobsOptions;
}

/** Aggregate counts for a queue, returned by the admin/stats endpoints. */
export interface QueueStats {
  name: JobNameValue;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: boolean;
}
