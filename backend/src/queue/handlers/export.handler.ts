/**
 * Async Job Queue — Export handler (long-running operation)
 *
 * Moves large data exports off the request thread. The HTTP export routes in
 * services/export.service.ts stream directly to the response, which is fine for
 * small exports but blocks an event-loop tick for very large result sets. This
 * handler builds the export out of band, stashes the payload in Redis under a
 * per-job key with a TTL, and returns a small summary pointer so the caller can
 * poll the job result and fetch the payload when ready.
 */

import { redis } from '../../config/redis';
import { logger } from '../../utils/logger';
import { buildTradesCsv, buildUserDataExport, logExportAudit } from '../../services/export.service';
import { getEnv } from '../../config/env';
import type { ExportJobData, ExportJobResult } from '../types';
import type { HandlerJob } from './util';
import { withTimeout } from './util';

/** How long the stashed export payload stays retrievable (Redis key TTL, seconds). */
const RESULT_TTL_SECONDS = 24 * 60 * 60;
/** Per-job hard execution timeout so a runaway export can't pin a worker forever. */
const EXPORT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function countCsvRows(csv: string): number {
  if (!csv) return 0;
  // Subtract the header row, if present.
  const lines = csv.trimEnd().split('\n');
  return Math.max(0, lines.length - 1);
}

export async function handleExportJob(
  job: HandlerJob<ExportJobData, ExportJobResult>,
): Promise<ExportJobResult> {
  const { type, from, to, userId, requestedBy } = job.data;
  const start = Date.now();
  logger.info({ jobId: job.id, type, userId, requestedBy }, 'Export job started');

  await job.updateProgress(0);

  const build = (async () => {
    if (type === 'trades') {
      const csv = await buildTradesCsv(from, to);
      const rows = countCsvRows(csv);
      const key = `queue:export:${job.id}:trades`;
      await redis.setex(key, RESULT_TTL_SECONDS, csv);
      return { rows, bytes: Buffer.byteLength(csv), location: key };
    }
    if (type === 'userData') {
      if (!userId) throw new Error('userData export requires userId');
      const doc = await buildUserDataExport(userId);
      const json = JSON.stringify(doc);
      const key = `queue:export:${job.id}:userData`;
      await redis.setex(key, RESULT_TTL_SECONDS, json);
      return { rows: 1, bytes: Buffer.byteLength(json), location: key };
    }
    throw new Error(`Unknown export type: ${String(type)}`);
  })();

  const { rows, bytes, location } = await withTimeout(build, EXPORT_TIMEOUT_MS, 'export');
  await job.updateProgress(100);

  // Audit the export run (table may not exist in some envs; logExportAudit swallows errors).
  if (requestedBy) {
    await logExportAudit(requestedBy, type, { jobId: job.id, rows, bytes }).catch(() => undefined);
  }

  const result: ExportJobResult = {
    type,
    rows,
    bytes,
    location,
    durationMs: Date.now() - start,
  };
  logger.info({ jobId: job.id, type, rows, bytes, durationMs: result.durationMs }, 'Export job completed');
  return result;
}

/** Retrieve a stashed export payload from Redis, or null if expired/not found. */
export async function fetchExportResult(location: string): Promise<string | null> {
  if (!getEnv().JOB_QUEUE_ENABLED) return null;
  return redis.get(location);
}
