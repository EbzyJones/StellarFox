/**
 * Rate Limit Administration Routes
 * 
 * Provides admin endpoints for managing and monitoring rate limits
 * Endpoints:
 * - GET /metrics - Current rate limit metrics
 * - GET /metrics/:date - Metrics for specific date
 * - GET /endpoints/:endpoint/stats - Stats for specific endpoint
 * - GET /anomalies - List detected anomalies
 * - POST /quota/allocate - Allocate temporary quota
 * - DELETE /quota/:key - Revoke quota
 * - POST /reset/:key - Reset rate limit for a key
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis';
import { RateLimitMonitor, RateLimitQuotaManager } from '../utils/rate-limit-monitor';
import { TokenBucketLimiter } from '../services/token-bucket-limiter';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

const router = express.Router();

// Initialize managers
const monitor = new RateLimitMonitor(redis);
const quotaManager = new RateLimitQuotaManager(redis);

/**
 * Middleware to verify admin access
 */
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const authenticatedReq = req as Request & { isAdmin?: boolean };
  
  if (!authenticatedReq.isAdmin) {
    return next(AppError.unauthorized('Admin access required'));
  }
  
  next();
}

/**
 * GET /api/admin/rate-limits/metrics
 * Get current rate limit metrics
 */
router.get('/metrics', requireAdmin, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const metrics = await monitor.getMetrics();
    res.json({
      success: true,
      data: metrics,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/rate-limits/metrics/:date
 * Get metrics for specific date (YYYY-MM-DD)
 */
router.get(
  '/metrics/:date',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const dateParam = Array.isArray(req.params.date) ? req.params.date[0] : req.params.date;

      // Validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        return next(AppError.badRequest('Invalid date format. Use YYYY-MM-DD'));
      }

      const metrics = await monitor.getMetrics(dateParam);
      res.json({
        success: true,
        date: dateParam,
        data: metrics,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/admin/rate-limits/endpoints/:endpoint/stats
 * Get statistics for a specific endpoint
 */
router.get(
  '/endpoints/:endpoint/stats',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const endpointParam = Array.isArray(req.params.endpoint) ? req.params.endpoint[0] : req.params.endpoint;
      const stats = await monitor.getEndpointStats(endpointParam);

      res.json({
        success: true,
        endpoint: endpointParam,
        data: stats,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/admin/rate-limits/anomalies
 * List detected anomalies
 */
router.get(
  '/anomalies',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let dateQuery: string | undefined;
      const dateVal = req.query.date;
      if (typeof dateVal === 'string') {
        dateQuery = dateVal;
      } else if (Array.isArray(dateVal)) {
        dateQuery = String(dateVal[0]);
      } else if (dateVal) {
        dateQuery = String(dateVal);
      }

      const anomalies = await monitor.listAnomalies(dateQuery);

      res.json({
        success: true,
        date: dateQuery || new Date().toISOString().split('T')[0],
        data: anomalies,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/admin/rate-limits/quota/allocate
 * Allocate temporary quota increase for a key
 * 
 * Body:
 * {
 *   "key": "user:123" or "ip:192.168.1.1",
 *   "tokensToAdd": 100,
 *   "durationMs": 3600000
 * }
 */
router.post(
  '/quota/allocate',
  requireAdmin,
  express.json(),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { key, tokensToAdd, durationMs } = req.body;

      // Validation
      if (!key || typeof key !== 'string') {
        return next(AppError.badRequest('key is required and must be a string'));
      }

      if (!Number.isInteger(tokensToAdd) || tokensToAdd <= 0) {
        return next(AppError.badRequest('tokensToAdd must be a positive integer'));
      }

      if (!Number.isInteger(durationMs) || durationMs <= 0) {
        return next(AppError.badRequest('durationMs must be a positive integer'));
      }

      const allocated = await quotaManager.allocateQuota(key, tokensToAdd, durationMs);

      if (!allocated) {
        return next(
          AppError.conflict('Quota allocation failed. Quota may already exist for this key'),
        );
      }

      res.json({
        success: true,
        message: 'Quota allocated successfully',
        data: {
          key,
          tokensToAdd,
          durationMs,
          expiresAt: new Date(Date.now() + durationMs),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * DELETE /api/admin/rate-limits/quota/:key
 * Revoke allocated quota for a key
 */
router.delete(
  '/quota/:key',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const keyParam = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;

      await quotaManager.revokeQuota(keyParam);

      res.json({
        success: true,
        message: 'Quota revoked successfully',
        data: { key: keyParam },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/admin/rate-limits/quota/:key
 * Get remaining quota for a key
 */
router.get(
  '/quota/:key',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const keyParam = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
      const quota = await quotaManager.getQuota(keyParam);

      res.json({
        success: true,
        data: {
          key: keyParam,
          quota,
          hasQuota: quota !== null,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/admin/rate-limits/reset/:key
 * Reset rate limit bucket for a specific key
 * Clears the token bucket, allowing fresh requests
 */
router.post(
  '/reset/:key',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const keyParam = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;

      if (!keyParam || typeof keyParam !== 'string') {
        return next(AppError.badRequest('key is required'));
      }

      // Create a limiter to perform reset
      const limiter = new TokenBucketLimiter(redis, {
        capacity: 100,
        tokensPerInterval: 1000,
        refillInterval: 60_000,
        keyPrefix: 'token-bucket',
      });

      await limiter.reset(keyParam);

      logger.info({ key: keyParam }, 'Rate limit reset by admin');

      res.json({
        success: true,
        message: 'Rate limit reset successfully',
        data: { key: keyParam },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/admin/rate-limits/reset-pattern/:pattern
 * Reset rate limit buckets matching a pattern
 * Pattern supports wildcards: user:*, ip:192.168.*, etc.
 */
router.post(
  '/reset-pattern/:pattern',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const patternParam = Array.isArray(req.params.pattern) ? req.params.pattern[0] : req.params.pattern;

      if (!patternParam || typeof patternParam !== 'string') {
        return next(AppError.badRequest('pattern is required'));
      }

      const limiter = new TokenBucketLimiter(redis, {
        capacity: 100,
        tokensPerInterval: 1000,
        refillInterval: 60_000,
        keyPrefix: 'token-bucket',
      });

      const deleted = await limiter.clearBucketsWithPattern(patternParam);

      logger.info({ pattern: patternParam, deleted }, 'Rate limits reset by admin for pattern');

      res.json({
        success: true,
        message: `${deleted} rate limit bucket(s) reset successfully`,
        data: { pattern: patternParam, deleted },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/admin/rate-limits/bucket/:key
 * Get current state of a rate limit bucket
 */
router.get(
  '/bucket/:key',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const keyParam = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;

      const limiter = new TokenBucketLimiter(redis, {
        capacity: 100,
        tokensPerInterval: 1000,
        refillInterval: 60_000,
        keyPrefix: 'token-bucket',
      });

      const state = await limiter.getState(keyParam);

      res.json({
        success: true,
        data: {
          key: keyParam,
          ...state,
          nextRefillAt: new Date(state.nextRefillAt),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/admin/rate-limits/cleanup
 * Manually trigger cleanup of old metrics
 * Query params:
 * - daysToKeep: Number of days of metrics to keep (default: 7)
 */
router.post(
  '/cleanup',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let daysToKeepParam = '7';
      const daysVal = req.query.daysToKeep;
      if (typeof daysVal === 'string') {
        daysToKeepParam = daysVal;
      } else if (Array.isArray(daysVal)) {
        daysToKeepParam = String(daysVal[0]);
      } else if (daysVal) {
        daysToKeepParam = String(daysVal);
      }

      const days = parseInt(daysToKeepParam, 10);

      if (!Number.isInteger(days) || days < 1) {
        return next(AppError.badRequest('daysToKeep must be a positive integer'));
      }

      const deleted = await monitor.cleanupOldMetrics(days);

      logger.info({ days, deleted }, 'Rate limit metrics cleanup performed by admin');

      res.json({
        success: true,
        message: 'Cleanup completed successfully',
        data: {
          daysToKeep: days,
          metricsDeleted: deleted,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/admin/rate-limits/cleanup/start
 * Start periodic cleanup of old metrics
 * Query params:
 * - intervalMs: Interval between cleanups (default: 86400000 = 24 hours)
 */
router.post(
  '/cleanup/start',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let intervalMsParam = '86400000';
      const intervalVal = req.query.intervalMs;
      if (typeof intervalVal === 'string') {
        intervalMsParam = intervalVal;
      } else if (Array.isArray(intervalVal)) {
        intervalMsParam = String(intervalVal[0]);
      } else if (intervalVal) {
        intervalMsParam = String(intervalVal);
      }

      const interval = parseInt(intervalMsParam, 10);

      if (!Number.isInteger(interval) || interval < 60000) {
        return next(AppError.badRequest('intervalMs must be at least 60000 (1 minute)'));
      }

      monitor.startPeriodicCleanup(interval);

      logger.info({ interval }, 'Started periodic rate limit metrics cleanup');

      res.json({
        success: true,
        message: 'Periodic cleanup started',
        data: { intervalMs: interval },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/admin/rate-limits/cleanup/stop
 * Stop periodic cleanup
 */
router.post(
  '/cleanup/stop',
  requireAdmin,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      monitor.stopPeriodicCleanup();

      logger.info('Stopped periodic rate limit metrics cleanup');

      res.json({
        success: true,
        message: 'Periodic cleanup stopped',
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
