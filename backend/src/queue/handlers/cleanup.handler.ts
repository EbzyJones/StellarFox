/**
 * Async Job Queue — Cleanup handler (scheduled task)
 *
 * Runs a single database retention/cleanup task per job. Reuses the functions in
 * services/cron.service.ts so the logic stays in one place; the queue just makes
 * each run durable and observable instead of relying on node-cron firing on every
 * process. The `task` field selects which cleanup runs, so one repeatable schedule
 * per task keeps runs independent and individually retryable.
 */

import {
  archiveFailedDistributions,
  cleanupOldBlockchainEvents,
  deleteExpiredPredictions,
  deleteExpiredResetTokens,
  deleteExpiredSessions,
  softDeleteOldNotifications,
} from '../../services/cron.service';
import { logger } from '../../utils/logger';
import type { CleanupJobData, CleanupJobResult } from '../types';
import type { HandlerJob } from './util';
import { withTimeout } from './util';

const CLEANUP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const TASKS: Record<CleanupJobData['task'], () => Promise<number>> = {
  sessions: deleteExpiredSessions,
  resetTokens: deleteExpiredResetTokens,
  predictions: deleteExpiredPredictions,
  notifications: softDeleteOldNotifications,
  distributions: archiveFailedDistributions,
  blockchainEvents: cleanupOldBlockchainEvents,
};

export async function handleCleanupJob(
  job: HandlerJob<CleanupJobData, CleanupJobResult>,
): Promise<CleanupJobResult> {
  const { task } = job.data;
  const runner = TASKS[task];
  if (!runner) throw new Error(`Unknown cleanup task: ${String(task)}`);

  logger.info({ jobId: job.id, task }, 'Cleanup job started');
  const deleted = await withTimeout(runner(), CLEANUP_TIMEOUT_MS, `cleanup:${task}`);
  logger.info({ jobId: job.id, task, deleted }, 'Cleanup job completed');
  return { task, deleted };
}
