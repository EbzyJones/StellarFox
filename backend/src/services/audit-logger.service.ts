import { Pool } from 'pg';
import { createHash, randomUUID } from 'crypto';
import { logger } from '../utils/logger';
import { pool } from '../config/db';

/**
 * Audit Log Entry for sensitive operations
 */
export interface AuditLogEntry {
  id: string;
  timestamp: Date;
  userId?: string;
  action: string;
  resource: string;
  resourceId: string;
  oldValues?: Record<string, any>;
  newValues?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  status: 'success' | 'failure';
  errorMessage?: string;
  checksum: string; // SHA-256 hash of entry + previous entry hash for tamper-proof chain
  previousChecksum?: string; // Hash of previous audit log entry
}

class AuditLoggerService {
  private lastChecksum: string = '';

  /**
   * Initialize audit logger - ensure table exists and seed initial checksum
   */
  async initialize(): Promise<void> {
    try {
      // Create audit log table if it doesn't exist
      await pool.query(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id UUID PRIMARY KEY,
          timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          user_id UUID,
          action VARCHAR(255) NOT NULL,
          resource VARCHAR(255) NOT NULL,
          resource_id VARCHAR(500) NOT NULL,
          old_values JSONB,
          new_values JSONB,
          ip_address INET,
          user_agent TEXT,
          status VARCHAR(50) NOT NULL,
          error_message TEXT,
          checksum VARCHAR(64) NOT NULL UNIQUE,
          previous_checksum VARCHAR(64),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          INDEX idx_user_timestamp (user_id, timestamp DESC),
          INDEX idx_resource_timestamp (resource, resource_id, timestamp DESC),
          INDEX idx_action_timestamp (action, timestamp DESC),
          INDEX idx_checksum (checksum),
          INDEX idx_previous_checksum (previous_checksum)
        )
      `);

      // Load the last checksum from database for chain integrity
      const result = await pool.query(
        'SELECT checksum FROM audit_logs ORDER BY timestamp DESC LIMIT 1'
      );
      
      if (result.rows.length > 0) {
        this.lastChecksum = result.rows[0].checksum;
        logger.info('Audit logger initialized with chain integrity check');
      } else {
        this.lastChecksum = '';
        logger.info('Audit logger initialized - starting new chain');
      }
    } catch (err) {
      logger.error({ err }, 'Failed to initialize audit logger');
      throw err;
    }
  }

  /**
   * Generate tamper-proof checksum using SHA-256
   * Chain includes: current entry + previous checksum for integrity verification
   */
  private generateChecksum(
    entry: Partial<AuditLogEntry>,
    previousChecksum: string
  ): string {
    const data = JSON.stringify({
      id: entry.id,
      timestamp: entry.timestamp,
      userId: entry.userId,
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId,
      status: entry.status,
      previousChecksum,
    });

    return createHash('sha256').update(data).digest('hex');
  }

  /**
   * Log a sensitive operation
   */
  async log(
    userId: string | undefined,
    action: string,
    resource: string,
    resourceId: string,
    options?: {
      oldValues?: Record<string, any>;
      newValues?: Record<string, any>;
      ipAddress?: string;
      userAgent?: string;
      status?: 'success' | 'failure';
      errorMessage?: string;
    }
  ): Promise<AuditLogEntry> {
    const id = randomUUID();
    const timestamp = new Date();
    const status = options?.status || 'success';

    // Create audit log entry
    const entry: AuditLogEntry = {
      id,
      timestamp,
      userId,
      action,
      resource,
      resourceId,
      oldValues: options?.oldValues,
      newValues: options?.newValues,
      ipAddress: options?.ipAddress,
      userAgent: options?.userAgent,
      status,
      errorMessage: options?.errorMessage,
      checksum: '', // Will be set below
      previousChecksum: this.lastChecksum,
    };

    // Generate tamper-proof checksum
    entry.checksum = this.generateChecksum(entry, this.lastChecksum);

    try {
      // Insert into database
      await pool.query(
        `INSERT INTO audit_logs (
          id, timestamp, user_id, action, resource, resource_id,
          old_values, new_values, ip_address, user_agent, status,
          error_message, checksum, previous_checksum
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          entry.id,
          entry.timestamp,
          entry.userId,
          entry.action,
          entry.resource,
          entry.resourceId,
          entry.oldValues ? JSON.stringify(entry.oldValues) : null,
          entry.newValues ? JSON.stringify(entry.newValues) : null,
          entry.ipAddress || null,
          entry.userAgent || null,
          entry.status,
          entry.errorMessage || null,
          entry.checksum,
          entry.previousChecksum || null,
        ]
      );

      // Update last checksum for chain integrity
      this.lastChecksum = entry.checksum;

      logger.info(
        {
          auditId: id,
          userId,
          action,
          resource,
          resourceId,
          status,
        },
        `Audit: ${action} on ${resource}`
      );

      return entry;
    } catch (err) {
      logger.error(
        { err, action, resource, resourceId },
        'Failed to log audit entry'
      );
      throw err;
    }
  }

  /**
   * Verify chain integrity by checking checksums
   */
  async verifyIntegrity(startId?: string): Promise<boolean> {
    try {
      const query = startId
        ? `SELECT * FROM audit_logs WHERE id = $1`
        : `SELECT * FROM audit_logs ORDER BY timestamp ASC LIMIT 1`;
      
      const params = startId ? [startId] : [];
      const result = await pool.query(query, params);

      if (result.rows.length === 0) {
        logger.warn('No audit logs to verify');
        return true;
      }

      let previousChecksum = '';

      for (const row of result.rows) {
        const expectedChecksum = this.generateChecksum(
          {
            id: row.id,
            timestamp: row.timestamp,
            userId: row.user_id,
            action: row.action,
            resource: row.resource,
            resourceId: row.resource_id,
            status: row.status,
          },
          row.previous_checksum || ''
        );

        if (expectedChecksum !== row.checksum) {
          logger.error(
            {
              auditId: row.id,
              expectedChecksum,
              actualChecksum: row.checksum,
            },
            'Audit log integrity check FAILED'
          );
          return false;
        }

        previousChecksum = row.checksum;
      }

      logger.info('Audit log integrity check PASSED');
      return true;
    } catch (err) {
      logger.error({ err }, 'Failed to verify audit log integrity');
      return false;
    }
  }

  /**
   * Retrieve audit logs with optional filtering
   */
  async getLogs(options?: {
    userId?: string;
    action?: string;
    resource?: string;
    resourceId?: string;
    startDate?: Date;
    endDate?: Date;
    limit?: number;
    offset?: number;
  }): Promise<AuditLogEntry[]> {
    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (options?.userId) {
      query += ` AND user_id = $${paramIndex++}`;
      params.push(options.userId);
    }

    if (options?.action) {
      query += ` AND action = $${paramIndex++}`;
      params.push(options.action);
    }

    if (options?.resource) {
      query += ` AND resource = $${paramIndex++}`;
      params.push(options.resource);
    }

    if (options?.resourceId) {
      query += ` AND resource_id = $${paramIndex++}`;
      params.push(options.resourceId);
    }

    if (options?.startDate) {
      query += ` AND timestamp >= $${paramIndex++}`;
      params.push(options.startDate);
    }

    if (options?.endDate) {
      query += ` AND timestamp <= $${paramIndex++}`;
      params.push(options.endDate);
    }

    query += ' ORDER BY timestamp DESC';

    if (options?.limit) {
      query += ` LIMIT $${paramIndex++}`;
      params.push(options.limit);
    }

    if (options?.offset) {
      query += ` OFFSET $${paramIndex++}`;
      params.push(options.offset);
    }

    try {
      const result = await pool.query(query, params);
      return result.rows.map((row) => ({
        id: row.id,
        timestamp: row.timestamp,
        userId: row.user_id,
        action: row.action,
        resource: row.resource,
        resourceId: row.resource_id,
        oldValues: row.old_values,
        newValues: row.new_values,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        status: row.status,
        errorMessage: row.error_message,
        checksum: row.checksum,
        previousChecksum: row.previous_checksum,
      }));
    } catch (err) {
      logger.error({ err }, 'Failed to retrieve audit logs');
      throw err;
    }
  }

  /**
   * Export audit logs as immutable format (e.g., for compliance)
   */
  async exportAuditTrail(
    options?: {
      startDate?: Date;
      endDate?: Date;
      format?: 'json' | 'csv';
    }
  ): Promise<string> {
    const logs = await this.getLogs({
      startDate: options?.startDate,
      endDate: options?.endDate,
      limit: 100000,
    });

    if (options?.format === 'csv') {
      return this.convertToCSV(logs);
    }

    return JSON.stringify(logs, null, 2);
  }

  /**
   * Convert audit logs to CSV format
   */
  private convertToCSV(logs: AuditLogEntry[]): string {
    const headers = [
      'ID',
      'Timestamp',
      'User ID',
      'Action',
      'Resource',
      'Resource ID',
      'Status',
      'Checksum',
      'Previous Checksum',
    ];

    const rows = logs.map((log) => [
      log.id,
      log.timestamp.toISOString(),
      log.userId || '',
      log.action,
      log.resource,
      log.resourceId,
      log.status,
      log.checksum,
      log.previousChecksum || '',
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
    ].join('\n');

    return csvContent;
  }
}

export const auditLogger = new AuditLoggerService();
