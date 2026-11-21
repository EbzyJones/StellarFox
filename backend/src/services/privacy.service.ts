import { createHash, randomUUID } from 'crypto';
import { pool } from '../config/db';
import { logger } from '../utils/logger';
import { auditLogger } from './audit-logger.service';

/**
 * Privacy and GDPR Compliance Service
 * Handles PII anonymization, data export, and right-to-be-forgotten requests
 */

/**
 * Patterns to identify and redact PII
 */
const PII_PATTERNS = {
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  phone: /\b(?:\+?1[-.\s]?)?\(?([0-9]{3})\)?[-.\s]?([0-9]{3})[-.\s]?([0-9]{4})\b/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  creditCard: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
  ipAddress: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
};

interface AnonymizationConfig {
  removeEmail?: boolean;
  removePhone?: boolean;
  removePersonalName?: boolean;
  removeAddress?: boolean;
  removePaymentInfo?: boolean;
  replaceWithHash?: boolean;
}

class PrivacyService {
  /**
   * Anonymize a string by removing PII
   */
  anonymizeString(
    text: string,
    config: AnonymizationConfig = {}
  ): string {
    let result = text;

    if (config.removeEmail) {
      result = result.replace(PII_PATTERNS.email, '[REDACTED-EMAIL]');
    }

    if (config.removePhone) {
      result = result.replace(PII_PATTERNS.phone, '[REDACTED-PHONE]');
    }

    if (config.removeAddress) {
      // Simple pattern for common address formats
      result = result.replace(
        /(\d+\s+[\w\s]+,\s*[\w\s]+,\s*\d{5}(?:-\d{4})?)/g,
        '[REDACTED-ADDRESS]'
      );
    }

    if (config.removePaymentInfo) {
      result = result.replace(PII_PATTERNS.creditCard, '[REDACTED-PAYMENT]');
    }

    return result;
  }

  /**
   * Anonymize object by removing/redacting sensitive fields
   */
  anonymizeObject(
    obj: Record<string, any>,
    config: AnonymizationConfig = {},
    sensitiveFields: string[] = []
  ): Record<string, any> {
    const anonymized: Record<string, any> = {};

    for (const [key, value] of Object.entries(obj)) {
      if (sensitiveFields.includes(key)) {
        anonymized[key] = config.replaceWithHash
          ? createHash('sha256').update(String(value)).digest('hex')
          : '[REDACTED]';
      } else if (typeof value === 'string') {
        anonymized[key] = this.anonymizeString(value, config);
      } else if (typeof value === 'object' && value !== null) {
        anonymized[key] = this.anonymizeObject(
          value,
          config,
          sensitiveFields
        );
      } else {
        anonymized[key] = value;
      }
    }

    return anonymized;
  }

  /**
   * Hash PII for pseudonymization (reversible with salt, used for linking)
   */
  pseudonymizeEmail(email: string, salt: string): string {
    return createHash('sha256')
      .update(`${email}:${salt}`)
      .digest('hex');
  }

  /**
   * Export user data (GDPR Right of Access)
   */
  async exportUserData(userId: string): Promise<Record<string, any>> {
    try {
      const userData: Record<string, any> = {
        exportedAt: new Date(),
        userId,
      };

      // Fetch user profile
      const userResult = await pool.query(
        `SELECT id, email, display_name, created_at, updated_at, stellar_address
         FROM users WHERE id = $1`,
        [userId]
      );

      if (userResult.rows.length > 0) {
        userData.profile = userResult.rows[0];
      }

      // Fetch user bets
      const betsResult = await pool.query(
        `SELECT * FROM bets WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId]
      );
      userData.bets = betsResult.rows;

      // Fetch disputes
      const disputesResult = await pool.query(
        `SELECT * FROM disputes WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId]
      );
      userData.disputes = disputesResult.rows;

      // Fetch activity logs
      const activityResult = await pool.query(
        `SELECT * FROM user_activity WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1000`,
        [userId]
      );
      userData.activity = activityResult.rows;

      // Log GDPR export request
      await auditLogger.log(userId, 'DATA_EXPORT', 'user', userId, {
        status: 'success',
      });

      logger.info({ userId }, 'User data exported for GDPR request');
      return userData;
    } catch (err) {
      logger.error({ err, userId }, 'Failed to export user data');
      throw err;
    }
  }

  /**
   * Delete user data (GDPR Right to be Forgotten)
   * Implements privacy by design - minimal data retention
   */
  async deleteUserData(userId: string): Promise<void> {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Anonymize bets (keep for audit trail, but remove PII)
      await client.query(
        `UPDATE bets 
         SET user_id = NULL, 
             updated_at = NOW() 
         WHERE user_id = $1`,
        [userId]
      );

      // Anonymize disputes
      await client.query(
        `UPDATE disputes 
         SET user_id = NULL, 
             evidence_url = NULL,
             updated_at = NOW() 
         WHERE user_id = $1`,
        [userId]
      );

      // Delete user activity logs
      await client.query(
        `DELETE FROM user_activity WHERE user_id = $1`,
        [userId]
      );

      // Delete user profile
      await client.query(
        `DELETE FROM users WHERE id = $1`,
        [userId]
      );

      await client.query('COMMIT');

      // Log deletion
      await auditLogger.log(userId, 'DATA_DELETION', 'user', userId, {
        status: 'success',
      });

      logger.info({ userId }, 'User data deleted per GDPR right to be forgotten');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, userId }, 'Failed to delete user data');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Restrict processing of user data (GDPR Right to Restrict Processing)
   */
  async restrictProcessing(userId: string, reason: string): Promise<void> {
    try {
      await pool.query(
        `UPDATE users 
         SET processing_restricted = TRUE, 
             processing_restriction_reason = $2,
             updated_at = NOW() 
         WHERE id = $1`,
        [userId, reason]
      );

      await auditLogger.log(userId, 'PROCESSING_RESTRICTED', 'user', userId, {
        newValues: { reason },
        status: 'success',
      });

      logger.info({ userId }, 'User data processing restricted');
    } catch (err) {
      logger.error({ err, userId }, 'Failed to restrict user data processing');
      throw err;
    }
  }

  /**
   * Check if processing is restricted for user
   */
  async isProcessingRestricted(userId: string): Promise<boolean> {
    try {
      const result = await pool.query(
        `SELECT processing_restricted FROM users WHERE id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return false;
      }

      return result.rows[0].processing_restricted === true;
    } catch (err) {
      logger.error({ err, userId }, 'Failed to check processing restriction');
      return false;
    }
  }

  /**
   * Get user privacy preferences
   */
  async getPrivacyPreferences(userId: string): Promise<Record<string, any>> {
    try {
      const result = await pool.query(
        `SELECT 
           marketing_emails_opt_in,
           analytics_opt_in,
           data_sharing_opt_in,
           processing_restricted
         FROM users 
         WHERE id = $1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return {};
      }

      return result.rows[0];
    } catch (err) {
      logger.error({ err, userId }, 'Failed to retrieve privacy preferences');
      throw err;
    }
  }

  /**
   * Update user privacy preferences
   */
  async updatePrivacyPreferences(
    userId: string,
    preferences: Record<string, boolean>
  ): Promise<void> {
    try {
      const setClauses: string[] = [];
      const params: any[] = [userId];
      let paramIndex = 2;

      for (const [key, value] of Object.entries(preferences)) {
        if (
          [
            'marketing_emails_opt_in',
            'analytics_opt_in',
            'data_sharing_opt_in',
          ].includes(key)
        ) {
          setClauses.push(`${key} = $${paramIndex++}`);
          params.push(value);
        }
      }

      if (setClauses.length === 0) {
        return;
      }

      setClauses.push('updated_at = NOW()');

      const query = `UPDATE users SET ${setClauses.join(', ')} WHERE id = $1`;
      await pool.query(query, params);

      await auditLogger.log(
        userId,
        'PRIVACY_PREFERENCES_UPDATED',
        'user',
        userId,
        {
          newValues: preferences,
          status: 'success',
        }
      );

      logger.info({ userId, preferences }, 'Privacy preferences updated');
    } catch (err) {
      logger.error({ err, userId }, 'Failed to update privacy preferences');
      throw err;
    }
  }

  /**
   * Get data retention settings
   */
  async getRetentionPolicy(): Promise<Record<string, number>> {
    return {
      userDataRetentionDays: parseInt(
        process.env.USER_DATA_RETENTION_DAYS || '2555',
        10
      ), // Default 7 years
      auditLogRetentionDays: parseInt(
        process.env.AUDIT_LOG_RETENTION_DAYS || '3650',
        10
      ), // Default 10 years
      activityLogRetentionDays: parseInt(
        process.env.ACTIVITY_LOG_RETENTION_DAYS || '365',
        10
      ), // Default 1 year
    };
  }

  /**
   * Purge expired data based on retention policy
   */
  async purgeExpiredData(): Promise<void> {
    try {
      const policy = await this.getRetentionPolicy();

      // Delete expired user activity logs
      await pool.query(
        `DELETE FROM user_activity 
         WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
        [policy.activityLogRetentionDays]
      );

      logger.info('Expired user activity logs purged');

      // Archive old audit logs (optional - move to cold storage)
      const archivedCount = await pool.query(
        `SELECT COUNT(*) as count FROM audit_logs 
         WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
        [policy.auditLogRetentionDays]
      );

      logger.info(
        { count: archivedCount.rows[0].count },
        'Audit logs eligible for archival'
      );
    } catch (err) {
      logger.error({ err }, 'Failed to purge expired data');
      throw err;
    }
  }
}

export const privacyService = new PrivacyService();
