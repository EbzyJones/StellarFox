/**
 * Async Job Queue — Snapshot handler (scheduled task)
 *
 * Records market probability snapshots on a schedule. Replaces the in-process
 * node-cron fire in cron/probabilitySnapshot.cron.ts with a durable, observable
 * BullMQ repeatable job: if the process crashes mid-run, the next scheduled run is
 * not lost (it is a queued job), and every run is visible in the admin routes and
 * Prometheus metrics.
 */

import { recordProbabilitySnapshots } from '../../services/MarketService';
import { logger } from '../../utils/logger';
import type { SnapshotJobData } from '../types';
import type { HandlerJob } from './util';
import { withTimeout } from './util';

const SNAPSHOT_TIMEOUT_MS = 90_000;

export async function handleSnapshotJob(
  job: HandlerJob<SnapshotJobData, { recorded: number }>,
): Promise<{ recorded: number }> {
  logger.info({ jobId: job.id, scheduledFor: job.data.scheduledFor }, 'Snapshot job started');
  const recorded = await withTimeout(
    recordProbabilitySnapshots(),
    SNAPSHOT_TIMEOUT_MS,
    'snapshot',
  );
  logger.info({ jobId: job.id, recorded }, 'Snapshot job completed');
  return { recorded };
}
