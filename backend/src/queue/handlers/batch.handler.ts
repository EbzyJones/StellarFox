/**
 * Async Job Queue — Batch handler (batch processing)
 *
 * A single durable job that processes a list of typed items with bounded
 * concurrency, per-item progress, and per-item timeouts. The actual per-item work
 * is supplied by a pluggable processor looked up by the `processor` key in the job
 * data, so the same queue can serve different batch strategies without a queue per
 * strategy. Real processors are registered at app startup via
 * `registerBatchProcessor`; a safe `log` processor ships built-in.
 */

import { logger } from '../../utils/logger';
import type { BatchJobData, BatchJobResult } from '../types';
import type { HandlerJob } from './util';
import { mapWithConcurrency, withTimeout, type ConcurrencyOutcome } from './util';

/** A processor receives the item payload and may throw; thrown errors count as a failure. */
export type BatchProcessor = (payload: unknown) => Promise<unknown>;

const processors = new Map<string, BatchProcessor>();

/** Register a batch processor under a stable key. Called at app startup. */
export function registerBatchProcessor(key: string, fn: BatchProcessor): void {
  if (processors.has(key)) {
    logger.warn({ key }, 'Batch processor already registered; overwriting');
  }
  processors.set(key, fn);
  logger.debug({ key }, 'Batch processor registered');
}

export function getBatchProcessor(key: string): BatchProcessor | undefined {
  return processors.get(key);
}

const BATCH_ITEM_TIMEOUT_MS = 30_000;
const BATCH_CONCURRENCY = 4;

// Built-in processor: logs the item id. Useful for testing the pipeline end-to-end
// and as a template for real processors.
registerBatchProcessor('log', async (payload) => {
  const p = payload as { id?: string };
  logger.debug({ itemId: p?.id }, 'batch:log processor ran');
  return p?.id;
});

/** Bulk-process items with bounded concurrency and per-item progress. */
export async function handleBatchJob(
  job: HandlerJob<BatchJobData, BatchJobResult>,
): Promise<BatchJobResult> {
  const { items, processor: processorKey } = job.data;
  const fn = getBatchProcessor(processorKey);
  if (!fn) {
    throw new Error(`Unknown batch processor: ${processorKey}`);
  }

  const total = items.length;
  logger.info({ jobId: job.id, processor: processorKey, total }, 'Batch job started');
  await job.updateProgress({ processed: 0, succeeded: 0, failed: 0, total });

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const failedIds: string[] = [];

  const outcomes: ConcurrencyOutcome<unknown>[] = await mapWithConcurrency(
    items,
    BATCH_CONCURRENCY,
    async (item) => withTimeout(fn(item.payload), BATCH_ITEM_TIMEOUT_MS, `batch:${processorKey}`),
  );

  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    processed++;
    if (o.status === 'fulfilled') {
      succeeded++;
    } else {
      failed++;
      failedIds.push(items[i].id);
      logger.warn(
        { jobId: job.id, itemId: items[i].id, reason: (o.reason as Error)?.message ?? o.reason },
        'Batch item failed',
      );
    }
    // Update progress every item; BullMQ coalesces rapid updates cheaply.
    await job.updateProgress({ processed, succeeded, failed, total });
  }

  const result: BatchJobResult = { processed, succeeded, failed, failedIds };
  logger.info(
    { jobId: job.id, processor: processorKey, processed, succeeded, failed },
    'Batch job completed',
  );
  return result;
}
