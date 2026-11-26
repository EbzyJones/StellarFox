/**
 * Migration: Webhook subscription and delivery tables
 *
 * Creates:
 *   webhook_subscriptions  – one row per registered endpoint
 *   webhook_deliveries     – one row per outbound dispatch attempt
 *
 * Design notes:
 *   - topics is stored as JSONB so we can use the @> containment operator
 *     to find subscriptions matching a given event without an array unnest.
 *   - secret_hash holds SHA-256(plaintext secret).  The plaintext is never
 *     stored; it is used only at registration time for display masking and
 *     then immediately discarded.
 *   - delivery status follows the lifecycle:
 *       pending → (success | retrying) → (success | exhausted)
 */

exports.up = async (pgm) => {
  // -------------------------------------------------------------------------
  // webhook_subscriptions
  // -------------------------------------------------------------------------
  pgm.createTable('webhook_subscriptions', {
    id: { type: 'text', primaryKey: true },
    user_id: {
      type: 'text',
      notNull: true,
      references: '"users"(id)',
      onDelete: 'CASCADE',
    },
    url: { type: 'text', notNull: true },
    secret_hash: { type: 'text', notNull: true },
    topics: { type: 'jsonb', notNull: true, default: "'[]'" },
    description: { type: 'text' },
    status: {
      type: 'text',
      notNull: true,
      default: "'active'",
      check: "status IN ('active', 'paused', 'disabled')",
    },
    failure_count: { type: 'integer', notNull: true, default: 0 },
    last_delivery_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: 'NOW()' },
    updated_at: { type: 'timestamptz', notNull: true, default: 'NOW()' },
  });

  pgm.createIndex('webhook_subscriptions', 'user_id');
  pgm.createIndex('webhook_subscriptions', 'status');
  // GIN index enables the @> containment query used in dispatchEvent.
  pgm.createIndex('webhook_subscriptions', 'topics', { method: 'gin' });

  // -------------------------------------------------------------------------
  // webhook_deliveries
  // -------------------------------------------------------------------------
  pgm.createTable('webhook_deliveries', {
    id: { type: 'text', primaryKey: true },
    webhook_id: {
      type: 'text',
      notNull: true,
      references: '"webhook_subscriptions"(id)',
      onDelete: 'CASCADE',
    },
    event_id: { type: 'text', notNull: true },
    event_type: { type: 'text', notNull: true },
    payload: { type: 'jsonb', notNull: true },
    status: {
      type: 'text',
      notNull: true,
      default: "'pending'",
      check: "status IN ('pending', 'success', 'failed', 'retrying', 'exhausted')",
    },
    attempt_count: { type: 'integer', notNull: true, default: 0 },
    last_http_status: { type: 'integer' },
    last_error: { type: 'text' },
    next_retry_at: { type: 'timestamptz' },
    delivered_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: 'NOW()' },
    updated_at: { type: 'timestamptz', notNull: true, default: 'NOW()' },
  });

  pgm.createIndex('webhook_deliveries', 'webhook_id');
  pgm.createIndex('webhook_deliveries', 'event_id');
  pgm.createIndex('webhook_deliveries', 'status');
  // Index used by the retry worker: WHERE status = 'retrying' AND next_retry_at <= NOW()
  pgm.createIndex('webhook_deliveries', ['status', 'next_retry_at']);
};

exports.down = async (pgm) => {
  pgm.dropTable('webhook_deliveries');
  pgm.dropTable('webhook_subscriptions');
};
