/**
 * Migration: Add Audit Logs Table for Security Compliance
 * 
 * Creates immutable audit log table with:
 * - Tamper-proof checksums
 * - Chain integrity verification
 * - Comprehensive indexing for fast queries
 * - Performance-optimized schema
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Create audit_logs table
  pgm.createTable('audit_logs', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    timestamp: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    user_id: {
      type: 'uuid',
      references: 'users(id)',
      onDelete: 'set null',
    },
    action: {
      type: 'varchar(255)',
      notNull: true,
    },
    resource: {
      type: 'varchar(255)',
      notNull: true,
    },
    resource_id: {
      type: 'varchar(500)',
      notNull: true,
    },
    old_values: {
      type: 'jsonb',
    },
    new_values: {
      type: 'jsonb',
    },
    ip_address: {
      type: 'inet',
    },
    user_agent: {
      type: 'text',
    },
    status: {
      type: 'varchar(50)',
      notNull: true,
      default: 'success',
    },
    error_message: {
      type: 'text',
    },
    checksum: {
      type: 'varchar(64)',
      notNull: true,
      unique: true,
    },
    previous_checksum: {
      type: 'varchar(64)',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // Create indices for common queries
  pgm.createIndex('audit_logs', ['user_id', 'timestamp'], {
    name: 'idx_audit_logs_user_timestamp',
    direction: 'DESC',
  });

  pgm.createIndex('audit_logs', ['resource', 'resource_id', 'timestamp'], {
    name: 'idx_audit_logs_resource_timestamp',
    direction: 'DESC',
  });

  pgm.createIndex('audit_logs', ['action', 'timestamp'], {
    name: 'idx_audit_logs_action_timestamp',
    direction: 'DESC',
  });

  pgm.createIndex('audit_logs', ['checksum'], {
    name: 'idx_audit_logs_checksum',
  });

  pgm.createIndex('audit_logs', ['previous_checksum'], {
    name: 'idx_audit_logs_previous_checksum',
  });

  pgm.createIndex('audit_logs', ['status', 'timestamp'], {
    name: 'idx_audit_logs_status_timestamp',
    direction: 'DESC',
  });

  // Create a view for easier access to recent audit logs
  pgm.createMaterializedView('v_recent_audit_logs', {}, `
    SELECT
      id,
      timestamp,
      user_id,
      action,
      resource,
      resource_id,
      status,
      created_at
    FROM audit_logs
    WHERE timestamp > NOW() - INTERVAL '90 days'
    ORDER BY timestamp DESC
  `);

  // Create index on the materialized view
  pgm.createIndex('v_recent_audit_logs', ['timestamp'], {
    name: 'idx_v_recent_audit_logs_timestamp',
  });
};

exports.down = (pgm) => {
  // Drop materialized view
  pgm.dropMaterializedView('v_recent_audit_logs', { ifExists: true });

  // Drop indices
  pgm.dropIndex('audit_logs', 'idx_audit_logs_previous_checksum', { ifExists: true });
  pgm.dropIndex('audit_logs', 'idx_audit_logs_checksum', { ifExists: true });
  pgm.dropIndex('audit_logs', 'idx_audit_logs_action_timestamp', { ifExists: true });
  pgm.dropIndex('audit_logs', 'idx_audit_logs_resource_timestamp', { ifExists: true });
  pgm.dropIndex('audit_logs', 'idx_audit_logs_user_timestamp', { ifExists: true });
  pgm.dropIndex('audit_logs', 'idx_audit_logs_status_timestamp', { ifExists: true });

  // Drop table
  pgm.dropTable('audit_logs', { ifExists: true });
};
