/**
 * Connection Pool Monitoring REST API
 *
 * Provides operational endpoints for real-time pool visibility and control.
 * All routes are admin-only and should sit behind requireAdminJwt.
 *
 *   GET  /api/pool/health          — structured health summary
 *   GET  /api/pool/snapshot        — single latest snapshot
 *   GET  /api/pool/history         — time-series snapshot array (for charts)
 *   GET  /api/pool/lifecycle       — recent connection lifecycle events
 *   GET  /api/pool/thresholds      — current alert threshold config
 *   PUT  /api/pool/thresholds      — update thresholds at runtime
 *   POST /api/pool/heal            — manually trigger self-healing routine
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { getConnectionPoolMonitor } from '../services/connectionPoolMonitor.service';

const router = Router();

/** Shared error helper */
function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ success: false, error: message });
}

function getMonitor() {
  return getConnectionPoolMonitor();
}

// ── GET /api/pool/health ──────────────────────────────────���───────────────────

/**
 * @openapi
 * /api/pool/health:
 *   get:
 *     summary: Connection pool health summary
 *     tags: [Pool Monitoring]
 *     responses:
 *       200:
 *         description: Health summary with status, issues, and recommendations
 */
router.get('/health', (_req: Request, res: Response) => {
  try {
    const summary = getMonitor().healthSummary();
    const httpStatus = summary.status === 'critical' ? 503 : 200;
    res.status(httpStatus).json({ success: true, ...summary });
  } catch (err) {
    logger.error({ err }, 'Pool health endpoint error');
    sendError(res, 500, 'Failed to retrieve pool health');
  }
});

// ── GET /api/pool/snapshot ────────────────────────────────────────────────────

/**
 * @openapi
 * /api/pool/snapshot:
 *   get:
 *     summary: Current pool state snapshot
 *     tags: [Pool Monitoring]
 */
router.get('/snapshot', (_req: Request, res: Response) => {
  try {
    const snapshot = getMonitor().currentSnapshot();
    if (!snapshot) {
      return sendError(res, 503, 'No snapshot available yet — monitor may still be initialising');
    }
    res.json({ success: true, snapshot });
  } catch (err) {
    logger.error({ err }, 'Pool snapshot endpoint error');
    sendError(res, 500, 'Failed to retrieve pool snapshot');
  }
});

// ── GET /api/pool/history ─────────────────────────────────────────────────────

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(60),
});

/**
 * @openapi
 * /api/pool/history:
 *   get:
 *     summary: Time-series pool snapshots for chart visualisation
 *     tags: [Pool Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 1000
 *           default: 60
 *         description: Maximum number of snapshots to return (most recent)
 */
router.get('/history', (req: Request, res: Response) => {
  try {
    const { limit } = historyQuerySchema.parse(req.query);
    const snapshots = getMonitor().snapshotHistory(limit);
    res.json({
      success: true,
      count: snapshots.length,
      snapshots,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return sendError(res, 400, `Invalid query parameters: ${err.errors.map((e) => e.message).join(', ')}`);
    }
    logger.error({ err }, 'Pool history endpoint error');
    sendError(res, 500, 'Failed to retrieve pool history');
  }
});

// ── GET /api/pool/lifecycle ───────────────────────────────────────────────────

const lifecycleQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  event: z.enum(['acquired', 'released', 'destroyed', 'error']).optional(),
});

/**
 * @openapi
 * /api/pool/lifecycle:
 *   get:
 *     summary: Recent connection lifecycle events
 *     tags: [Pool Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *       - in: query
 *         name: event
 *         schema:
 *           type: string
 *           enum: [acquired, released, destroyed, error]
 *         description: Filter to a specific event type
 */
router.get('/lifecycle', (req: Request, res: Response) => {
  try {
    const { limit, event } = lifecycleQuerySchema.parse(req.query);
    let events = getMonitor().lifecycleHistory();
    if (event) {
      events = events.filter((e) => e.event === event);
    }
    const sliced = events.slice(0, limit);
    res.json({ success: true, count: sliced.length, events: sliced });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return sendError(res, 400, `Invalid query parameters: ${err.errors.map((e) => e.message).join(', ')}`);
    }
    logger.error({ err }, 'Pool lifecycle endpoint error');
    sendError(res, 500, 'Failed to retrieve lifecycle events');
  }
});

// ── GET /api/pool/thresholds ──────────────────────────────────────────────────

/**
 * @openapi
 * /api/pool/thresholds:
 *   get:
 *     summary: Current alert threshold configuration
 *     tags: [Pool Monitoring]
 */
router.get('/thresholds', (_req: Request, res: Response) => {
  try {
    const thresholds = getMonitor().getThresholds();
    res.json({ success: true, thresholds });
  } catch (err) {
    logger.error({ err }, 'Pool thresholds GET error');
    sendError(res, 500, 'Failed to retrieve thresholds');
  }
});

// ── PUT /api/pool/thresholds ──────────────────────────────────────────────────

const updateThresholdsSchema = z.object({
  utilizationWarnPct: z.number().min(1).max(100).optional(),
  utilizationCriticalPct: z.number().min(1).max(100).optional(),
  waitingWarnCount: z.number().int().min(1).optional(),
  waitingCriticalCount: z.number().int().min(1).optional(),
  errorRateWarnCount: z.number().int().min(1).optional(),
  errorRateCriticalCount: z.number().int().min(1).optional(),
  acquireWaitWarnMs: z.number().min(1).optional(),
  selfHealCullPct: z.number().min(1).max(100).optional(),
  selfHealCircuitBreakTicks: z.number().int().min(1).optional(),
  alertDebounceMs: z.number().min(0).optional(),
});

/**
 * @openapi
 * /api/pool/thresholds:
 *   put:
 *     summary: Update alert thresholds at runtime
 *     tags: [Pool Monitoring]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateThresholdsRequest'
 */
router.put('/thresholds', (req: Request, res: Response) => {
  try {
    const overrides = updateThresholdsSchema.parse(req.body);
    if (Object.keys(overrides).length === 0) {
      return sendError(res, 400, 'No threshold fields provided');
    }
    getMonitor().updateThresholds(overrides);
    logger.info({ overrides }, 'Pool thresholds updated via API');
    res.json({ success: true, thresholds: getMonitor().getThresholds() });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return sendError(res, 400, `Validation error: ${err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`);
    }
    logger.error({ err }, 'Pool thresholds PUT error');
    sendError(res, 500, 'Failed to update thresholds');
  }
});

// ── POST /api/pool/heal ───────────────────────────────────────────────────────

/**
 * @openapi
 * /api/pool/heal:
 *   post:
 *     summary: Manually trigger the self-healing routine
 *     tags: [Pool Monitoring]
 *     responses:
 *       200:
 *         description: Actions taken during the healing pass
 */
router.post('/heal', async (_req: Request, res: Response) => {
  try {
    const actions = await getMonitor().selfHeal();
    logger.info({ actionCount: actions.length }, 'Manual pool self-heal triggered via API');
    res.json({
      success: true,
      actionCount: actions.length,
      actions,
    });
  } catch (err) {
    logger.error({ err }, 'Pool self-heal endpoint error');
    sendError(res, 500, 'Self-healing routine failed');
  }
});

export default router;
