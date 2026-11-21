import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth-enhanced.middleware';
import { requireRole } from '../middleware/validation.middleware';
import { auditLogger } from '../services/audit-logger.service';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

const router = Router();

/**
 * GET /api/admin/audit/logs
 * Retrieve audit logs (admin only)
 */
router.get(
  '/logs',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, action, resource, startDate, endDate, limit = 100, offset = 0 } = req.query;

      const logs = await auditLogger.getLogs({
        userId: userId as string | undefined,
        action: action as string | undefined,
        resource: resource as string | undefined,
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        limit: Math.min(parseInt(String(limit)) || 100, 1000),
        offset: parseInt(String(offset)) || 0,
      });

      await auditLogger.log(
        (req as any).userId,
        'AUDIT_LOGS_VIEWED',
        'audit',
        'logs',
        {
          newValues: {
            filters: {
              userId,
              action,
              resource,
              startDate,
              endDate,
            },
          },
          status: 'success',
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
        }
      );

      res.json({
        message: 'Audit logs retrieved',
        count: logs.length,
        logs,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/admin/audit/logs/:id
 * Retrieve specific audit log entry
 */
router.get(
  '/logs/:id',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const logs = await auditLogger.getLogs({
        limit: 1,
      });

      const log = logs.find((l) => l.id === id);

      if (!log) {
        return next(AppError.notFound('Audit log not found'));
      }

      res.json({
        message: 'Audit log retrieved',
        log,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/admin/audit/verify
 * Verify audit log integrity
 */
router.post(
  '/verify',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      logger.info('Starting audit log integrity verification...');

      const isValid = await auditLogger.verifyIntegrity();

      await auditLogger.log(
        (req as any).userId,
        'AUDIT_INTEGRITY_VERIFIED',
        'audit',
        'integrity',
        {
          newValues: { isValid },
          status: 'success',
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
        }
      );

      res.json({
        message: isValid ? 'Audit log integrity verified' : 'Audit log integrity check FAILED',
        isValid,
        verifiedAt: new Date(),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/admin/audit/export
 * Export audit logs for compliance
 */
router.get(
  '/export',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { startDate, endDate, format = 'json' } = req.query;

      if (!['json', 'csv'].includes(String(format))) {
        return next(AppError.badRequest('Format must be json or csv'));
      }

      const exportData = await auditLogger.exportAuditTrail({
        startDate: startDate ? new Date(startDate as string) : undefined,
        endDate: endDate ? new Date(endDate as string) : undefined,
        format: format as 'json' | 'csv' | undefined,
      });

      await auditLogger.log(
        (req as any).userId,
        'AUDIT_EXPORT_REQUESTED',
        'audit',
        'export',
        {
          newValues: {
            format,
            startDate,
            endDate,
          },
          status: 'success',
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
        }
      );

      const filename = `audit-trail-${Date.now()}.${format}`;

      res.set({
        'Content-Type': format === 'json' ? 'application/json' : 'text/csv',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });

      res.send(exportData);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/admin/audit/stats
 * Get audit log statistics
 */
router.get(
  '/stats',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const logs = await auditLogger.getLogs({
        startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Last 30 days
        limit: 100000,
      });

      // Calculate statistics
      const stats = {
        totalEntries: logs.length,
        successCount: logs.filter((l) => l.status === 'success').length,
        failureCount: logs.filter((l) => l.status === 'failure').length,
        actionBreakdown: {} as Record<string, number>,
        resourceBreakdown: {} as Record<string, number>,
        topUsers: {} as Record<string, number>,
      };

      for (const log of logs) {
        // Action breakdown
        stats.actionBreakdown[log.action] =
          (stats.actionBreakdown[log.action] || 0) + 1;

        // Resource breakdown
        stats.resourceBreakdown[log.resource] =
          (stats.resourceBreakdown[log.resource] || 0) + 1;

        // Top users
        if (log.userId) {
          stats.topUsers[log.userId] = (stats.topUsers[log.userId] || 0) + 1;
        }
      }

      // Sort top users and limit to top 10
      const sortedTopUsers = Object.entries(stats.topUsers)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10)
        .reduce((acc, [userId, count]) => {
          acc[userId] = count;
          return acc;
        }, {} as Record<string, number>);

      res.json({
        message: 'Audit statistics',
        stats: {
          ...stats,
          topUsers: sortedTopUsers,
        },
        period: '30 days',
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/admin/audit/search
 * Search audit logs with advanced filters
 */
router.post(
  '/search',
  requireAuth,
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const {
        userId,
        action,
        resource,
        status,
        startDate,
        endDate,
        limit = 100,
        offset = 0,
      } = req.body;

      const logs = await auditLogger.getLogs({
        userId,
        action,
        resource,
        startDate: startDate ? new Date(startDate) : undefined,
        endDate: endDate ? new Date(endDate) : undefined,
        limit: Math.min(limit, 1000),
        offset,
      });

      // Filter by status if provided
      const filtered = status
        ? logs.filter((l) => l.status === status)
        : logs;

      res.json({
        message: 'Audit search results',
        query: {
          userId,
          action,
          resource,
          status,
          startDate,
          endDate,
        },
        count: filtered.length,
        logs: filtered,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
