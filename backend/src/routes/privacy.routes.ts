import { Router, Request, Response, NextFunction } from 'express';
import { requireAuth } from '../middleware/auth-enhanced.middleware';
import { privacyService } from '../services/privacy.service';
import { auditLogger } from '../services/audit-logger.service';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

const router = Router();

/**
 * GET /api/privacy/preferences
 * Retrieve user's privacy preferences
 */
router.get(
  '/preferences',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).userId;

      const preferences = await privacyService.getPrivacyPreferences(userId);

      await auditLogger.log(userId, 'PRIVACY_PREFERENCES_VIEWED', 'user', userId, {
        status: 'success',
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      });

      res.json(preferences);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /api/privacy/preferences
 * Update user's privacy preferences
 */
router.put(
  '/preferences',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).userId;
      const { marketing_emails_opt_in, analytics_opt_in, data_sharing_opt_in } = req.body;

      const oldPreferences = await privacyService.getPrivacyPreferences(userId);

      const preferences = {
        ...(marketing_emails_opt_in !== undefined && { marketing_emails_opt_in }),
        ...(analytics_opt_in !== undefined && { analytics_opt_in }),
        ...(data_sharing_opt_in !== undefined && { data_sharing_opt_in }),
      };

      await privacyService.updatePrivacyPreferences(userId, preferences);

      await auditLogger.log(
        userId,
        'PRIVACY_PREFERENCES_UPDATED',
        'user',
        userId,
        {
          oldValues: oldPreferences,
          newValues: preferences,
          status: 'success',
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
        }
      );

      res.json({
        message: 'Privacy preferences updated',
        preferences,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/privacy/data-export
 * Export all user data (GDPR Right of Access)
 */
router.post(
  '/data-export',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).userId;

      logger.info({ userId }, 'User requesting data export');

      const userData = await privacyService.exportUserData(userId);

      res.json({
        message: 'Data exported successfully',
        data: userData,
        exportedAt: new Date(),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/privacy/data-deletion
 * Delete all user data (GDPR Right to be Forgotten)
 * Requires confirmation
 */
router.post(
  '/data-deletion',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).userId;
      const { confirmDeletion } = req.body;

      if (confirmDeletion !== true) {
        return next(AppError.badRequest('Deletion confirmation required'));
      }

      logger.warn({ userId }, 'User requesting account deletion');

      await auditLogger.log(
        userId,
        'ACCOUNT_DELETION_REQUESTED',
        'user',
        userId,
        {
          status: 'success',
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
        }
      );

      await privacyService.deleteUserData(userId);

      res.json({
        message: 'Account and all associated data have been deleted',
        deletedAt: new Date(),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/privacy/restrict-processing
 * Restrict processing of user data (GDPR Right to Restrict Processing)
 */
router.post(
  '/restrict-processing',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = (req as any).userId;
      const { reason } = req.body;

      if (!reason || typeof reason !== 'string') {
        return next(AppError.badRequest('Reason for restriction is required'));
      }

      await privacyService.restrictProcessing(userId, reason);

      await auditLogger.log(
        userId,
        'PROCESSING_RESTRICTION_APPLIED',
        'user',
        userId,
        {
          newValues: { reason },
          status: 'success',
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
        }
      );

      res.json({
        message: 'Data processing restricted',
        reason,
        restrictedAt: new Date(),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/privacy/retention-policy
 * Get data retention policy
 */
router.get(
  '/retention-policy',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const policy = await privacyService.getRetentionPolicy();

      res.json({
        message: 'Data retention policy',
        policy,
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
