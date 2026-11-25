/**
 * Admin / observability routes for the async job queue.
 *
 * Mounted under /api/admin/queues (see index.ts). Every route requires an admin
 * JWT (requireAdmin), so queue inspection and control are admin-only. The routes
 * intentionally never mutate business data directly — they only manage jobs and
 * queue state via the QueueManager.
 *
 * Endpoints:
 *   GET    /                       — overview of all queues
 *   GET    /:name/stats            — per-queue counts
 *   GET    /:name/jobs             — list jobs (?status=&start=&end=)
 *   GET    /:name/jobs/:id         — job detail (data, result, attempts, stack)
 *   POST   /:name/jobs/:id/retry   — re-queue a failed job
 *   DELETE /:name/jobs/:id         — remove a job
 *   POST   /:name/pause            — pause a queue
 *   POST   /:name/resume           — resume a queue
 *   GET    /:name/jobs/:id/export  — fetch a stashed export job payload
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { logger } from '../utils/logger';
import { requireAdmin } from '../middleware/requireAdminJwt.middleware';
import { queueManager } from '../queue';
import { QUEUE_DEFINITIONS } from '../queue/registry';
import { fetchExportResult } from '../queue/handlers/export.handler';
import type { JobNameValue } from '../queue/types';

const router = Router();

const KNOWN_NAMES = new Set<string>(QUEUE_DEFINITIONS.map((d) => d.name));

/** Reject unknown queue names with 404 rather than letting an error bubble as 500. */
function resolveName(req: Request, res: Response): JobNameValue | null {
  const name = String(req.params.name);
  if (!KNOWN_NAMES.has(name)) {
    res.status(404).json({ error: `Unknown queue: ${name}` });
    return null;
  }
  return name as JobNameValue;
}

// All routes below require an admin JWT.
router.use(requireAdmin);

/** GET / — overview of every queue, including uninstantiated ones (all zeros). */
router.get('/', async (_req, res, next) => {
  try {
    const stats = await queueManager.getAllStats();
    res.json({
      queues: stats,
      descriptions: Object.fromEntries(
        QUEUE_DEFINITIONS.map((d) => [d.name, d.description]),
      ),
    });
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'Failed to get queue overview');
    next(err);
  }
});

/** GET /:name/stats — aggregate counts plus paused flag. */
router.get('/:name/stats', async (req, res, next) => {
  const name = resolveName(req, res);
  if (!name) return;
  try {
    res.json(await queueManager.getStats(name));
  } catch (err) {
    logger.error({ err: (err as Error).message, queue: name }, 'Failed to get queue stats');
    next(err);
  }
});

/** GET /:name/jobs — list jobs. ?status may be a single status or comma list. */
router.get('/:name/jobs', async (req, res, next) => {
  const name = resolveName(req, res);
  if (!name) return;
  try {
    const statusParam = typeof req.query.status === 'string' ? req.query.status : '';
    const types = statusParam ? statusParam.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const start = Math.max(0, Number(req.query.start ?? 0) || 0);
    // ?limit caps page size (default 50, hard cap 200). end is inclusive for BullMQ.
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50));
    const end = start + limit - 1;
    const jobs = await queueManager.getJobs(name, { start, end, types });
    res.json({
      jobs: jobs.map((job) => ({
        id: job.id,
        name: job.name,
        data: job.data,
        result: job.returnvalue,
        attemptsMade: job.attemptsMade,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
        failedReason: job.failedReason,
        timestamp: job.timestamp,
      })),
    });
  } catch (err) {
    logger.error({ err: (err as Error).message, queue: name }, 'Failed to list jobs');
    next(err);
  }
});

/** GET /:name/jobs/:id — full job detail, including the recorded error stacktrace. */
router.get('/:name/jobs/:id', async (req, res, next) => {
  const name = resolveName(req, res);
  if (!name) return;
  try {
    const job = await queueManager.getJob(name, String(req.params.id));
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json({
      id: job.id,
      name: job.name,
      data: job.data,
      result: job.returnvalue,
      opts: { attempts: job.opts.attempts, priority: job.opts.priority, repeat: job.opts.repeat },
      attemptsMade: job.attemptsMade,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      failedReason: job.failedReason,
      stacktrace: job.stacktrace,
      timestamp: job.timestamp,
    });
  } catch (err) {
    logger.error({ err: (err as Error).message, queue: name }, 'Failed to get job');
    next(err);
  }
});

/** POST /:name/jobs/:id/retry — move a failed job back to the waiting set. */
router.post('/:name/jobs/:id/retry', async (req, res, next) => {
  const name = resolveName(req, res);
  if (!name) return;
  try {
    await queueManager.retryJob(name, String(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    const message = (err as Error).message;
    if (/not found/i.test(message)) {
      return res.status(404).json({ error: message });
    }
    logger.error({ err: message, queue: name }, 'Failed to retry job');
    next(err);
  }
});

/** DELETE /:name/jobs/:id — remove a job from the queue. */
router.delete('/:name/jobs/:id', async (req, res, next) => {
  const name = resolveName(req, res);
  if (!name) return;
  try {
    await queueManager.removeJob(name, String(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    const message = (err as Error).message;
    if (/not found/i.test(message)) {
      return res.status(404).json({ error: message });
    }
    logger.error({ err: message, queue: name }, 'Failed to remove job');
    next(err);
  }
});

/** POST /:name/pause — pause a queue (in-flight jobs finish; new ones wait). */
router.post('/:name/pause', async (req, res, next) => {
  const name = resolveName(req, res);
  if (!name) return;
  try {
    await queueManager.pause(name);
    res.json({ ok: true, paused: true });
  } catch (err) {
    logger.error({ err: (err as Error).message, queue: name }, 'Failed to pause queue');
    next(err);
  }
});

/** POST /:name/resume — resume a paused queue. */
router.post('/:name/resume', async (req, res, next) => {
  const name = resolveName(req, res);
  if (!name) return;
  try {
    await queueManager.resume(name);
    res.json({ ok: true, paused: false });
  } catch (err) {
    logger.error({ err: (err as Error).message, queue: name }, 'Failed to resume queue');
    next(err);
  }
});

/**
 * GET /:name/jobs/:id/export — fetch the stashed payload of a completed export job.
 * Only valid for the export queue; the payload lives in Redis for RESULT_TTL_SECONDS.
 */
router.get('/:name/jobs/:id/export', async (req, res, next) => {
  const name = resolveName(req, res);
  if (!name) return;
  if (name !== 'export') {
    return res.status(400).json({ error: 'Export payload fetch is only available on the export queue' });
  }
  try {
    const job = await queueManager.getJob(name, String(req.params.id));
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const location = (job.returnvalue as { location?: string } | undefined)?.location;
    if (!location) {
      return res.status(404).json({ error: 'Job has no stashed export payload (not completed or expired)' });
    }
    const payload = await fetchExportResult(location);
    if (payload == null) {
      return res.status(410).json({ error: 'Export payload expired or missing' });
    }
    const isUserData = (job.data as { type?: string } | undefined)?.type === 'userData';
    res
      .set('Content-Type', isUserData ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8')
      .set(
        'Content-Disposition',
        `attachment; filename="export-${job.id}.${isUserData ? 'json' : 'csv'}"`,
      )
      .send(payload);
  } catch (err) {
    logger.error({ err: (err as Error).message, queue: name }, 'Failed to fetch export payload');
    next(err);
  }
});

export default router;
