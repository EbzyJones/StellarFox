/**
 * Migration: Add Privacy and GDPR Compliance Columns
 * 
 * Adds columns to users table for:
 * - Privacy preference management
 * - Processing restriction flags
 * - GDPR compliance tracking
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // Add privacy-related columns to users table
  pgm.addColumns('users', {
    // Privacy preferences
    marketing_emails_opt_in: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
    analytics_opt_in: {
      type: 'boolean',
      notNull: true,
      default: true,
    },
    data_sharing_opt_in: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
    
    // GDPR: Right to Restrict Processing
    processing_restricted: {
      type: 'boolean',
      notNull: true,
      default: false,
    },
    processing_restriction_reason: {
      type: 'text',
    },
    processing_restriction_date: {
      type: 'timestamptz',
    },
    
    // Data export tracking
    last_data_export_at: {
      type: 'timestamptz',
    },
    
    // Account deletion tracking (soft delete support)
    deleted_at: {
      type: 'timestamptz',
    },
  });

  // Create index for filtering deleted users
  pgm.createIndex('users', ['deleted_at'], {
    name: 'idx_users_deleted_at',
  });

  // Create index for privacy preferences
  pgm.createIndex('users', ['marketing_emails_opt_in', 'analytics_opt_in'], {
    name: 'idx_users_privacy_prefs',
  });

  // Create privacy audit table for tracking consent changes
  pgm.createTable('privacy_audit', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    user_id: {
      type: 'uuid',
      notNull: true,
      references: 'users(id)',
      onDelete: 'cascade',
    },
    action: {
      type: 'varchar(100)',
      notNull: true,
      // Values: 'PREFERENCES_UPDATED', 'PROCESSING_RESTRICTED', 'DATA_EXPORTED', 'DATA_DELETED'
    },
    old_values: {
      type: 'jsonb',
    },
    new_values: {
      type: 'jsonb',
    },
    reason: {
      type: 'text',
    },
    ip_address: {
      type: 'inet',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });

  // Create indices for privacy audit table
  pgm.createIndex('privacy_audit', ['user_id', 'created_at'], {
    name: 'idx_privacy_audit_user_timestamp',
    direction: 'DESC',
  });

  pgm.createIndex('privacy_audit', ['action', 'created_at'], {
    name: 'idx_privacy_audit_action_timestamp',
    direction: 'DESC',
  });
};

exports.down = (pgm) => {
  // Drop privacy audit table
  pgm.dropTable('privacy_audit', { ifExists: true });

  // Drop indices
  pgm.dropIndex('users', 'idx_users_privacy_prefs', { ifExists: true });
  pgm.dropIndex('users', 'idx_users_deleted_at', { ifExists: true });

  // Drop columns
  pgm.dropColumns('users', [
    'marketing_emails_opt_in',
    'analytics_opt_in',
    'data_sharing_opt_in',
    'processing_restricted',
    'processing_restriction_reason',
    'processing_restriction_date',
    'last_data_export_at',
    'deleted_at',
  ]);
};
