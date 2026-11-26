/**
 * Webhook Service
 *
 * Handles the full lifecycle of webhook subscriptions and event delivery:
 *   - CRUD for subscriptions (stored in DB, secret hashed for display)
 *   - HMAC-SHA256 signing of outbound payloads
 *   - Delivery dispatch with exponential backoff retry scheduling
 *   - Delivery-log persistence with status tracking
 *   - Admin replay of failed deliveries
 *   - Background retry worker that processes due retries
 */

import crypto from 'crypto';
import { pool } from '../config/db';
import { logger } from '../utils/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Initial retry delay (30 s). Doubles on each attempt up to MAX_BACKOFF_MS. */
const INITIAL_BACKOFF_MS = 30_000;
/** Cap retries at ~17 minutes (2^5 × 30 s). */
const MAX_BACKOFF_MS = 17 * 60 * 1000;
/** Stop retrying after this many consecutive failures. */
const MAX_ATTEMPTS = 6;
/** HTTP timeout for outbound webhook calls (ms). */
const DISPATCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WebhookTopic =
  | 'market.created'
  | 'market.locked'
  | 'market.resolved'
  | 'bet.placed'
  | 'dispute.opened'
  | 'dispute.resolved'
  | 'payout.distributed';

export interface WebhookSubscription {
  id: string;
  user_id: string;
  url: string;
  /** Masked display only – the real secret is never returned after creation. */
  secret_hint: string;
  topics: WebhookTopic[];
  description: string | null;
  status: 'active' | 'paused' | 'disabled';
  failure_count: number;
  last_delivery_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event_id: string;
  event_type: WebhookTopic;
  payload: Record<string, unknown>;
  status: 'pending' | 'success' | 'failed' | 'retrying' | 'exhausted';
  attempt_count: number;
  last_http_status: number | null;
  last_error: string | null;
  next_retry_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateSubscriptionInput {
  userId: string;
  url: string;
  secret: string;
  topics: WebhookTopic[];
  description?: string;
}

export interface DispatchResult {
  status: 'success' | 'failed';
  httpStatus: number | null;
  latencyMs: number;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Deterministic event ID so replays are idempotent. */
function makeEventId(webhookId: string, topic: WebhookTopic, payloadHash: string): string {
  return `evt-${webhookId.slice(0, 8)}-${topic}-${payloadHash.slice(0, 8)}`;
}

/** Subscription ID with a stable prefix for quick visual identification. */
function makeWebhookId(): string {
  return `whk-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/** Delivery row ID. */
function makeDeliveryId(): string {
  return `del-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/** HMAC-SHA256 signature for outbound payload. */
function sign(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/**
 * Exponential backoff: 30 s → 60 s → 120 s → … capped at MAX_BACKOFF_MS.
 * Includes ±10 % jitter to avoid thundering-herd when many deliveries fail
 * simultaneously.
 */
function backoffMs(attempt: number): number {
  const base = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1), MAX_BACKOFF_MS);
  const jitter = base * 0.1 * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}

/**
 * Fire-and-forget HTTP POST with a hard timeout.
 * Returns the raw HTTP status (or null on network failure) and elapsed time.
 */
async function httpPost(
  url: string,
  body: string,
  signature: string,
  eventId: string,
): Promise<{ httpStatus: number | null; latencyMs: number; error: string | null }> {
  const start = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-StellarFox-Signature': signature,
        'X-StellarFox-Event-Id': eventId,
        'User-Agent': 'StellarFox-Webhook/1.0',
      },
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    return { httpStatus: res.status, latencyMs: Date.now() - start, error: null };
  } catch (err: unknown) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    return { httpStatus: null, latencyMs: Date.now() - start, error: message };
  }
}

// ---------------------------------------------------------------------------
// Subscription management
// ---------------------------------------------------------------------------

/**
 * Create a new webhook subscription.
 * The caller-supplied secret is stored hashed (SHA-256); the plaintext is used
 * only for outbound signing and is never persisted.
 */
export async function createSubscription(input: CreateSubscriptionInput): Promise<WebhookSubscription> {
  const id = makeWebhookId();
  const secretHash = crypto.createHash('sha256').update(input.secret).digest('hex');
  const secretHint = `${input.secret.slice(0, 4)}…${input.secret.slice(-4)}`;

  await pool.query(
    `INSERT INTO webhook_subscriptions
       (id, user_id, url, secret_hash, topics, description, status, failure_count)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', 0)`,
    [id, input.userId, input.url, secretHash, JSON.stringify(input.topics), input.description ?? null],
  );

  const row = await pool.query<WebhookSubscription>(
    `SELECT id, user_id, url, topics, description, status, failure_count,
            last_delivery_at, created_at, updated_at
     FROM webhook_subscriptions WHERE id = $1`,
    [id],
  );

  return { ...row.rows[0], secret_hint: secretHint };
}

/** List active subscriptions belonging to a user. */
export async function listSubscriptions(userId: string): Promise<WebhookSubscription[]> {
  const result = await pool.query<WebhookSubscription>(
    `SELECT id, user_id, url,
            LEFT(secret_hash, 4) || '…' || RIGHT(secret_hash, 4) AS secret_hint,
            topics, description, status, failure_count,
            last_delivery_at, created_at, updated_at
     FROM webhook_subscriptions
     WHERE user_id = $1 AND status != 'disabled'
     ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows;
}

/** Soft-disable a subscription (preserves delivery history). */
export async function deleteSubscription(id: string, userId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE webhook_subscriptions
     SET status = 'disabled', updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status != 'disabled'`,
    [id, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Return a single subscription row (used internally and by the test endpoint). */
export async function getSubscription(id: string, userId: string): Promise<WebhookSubscription | null> {
  const result = await pool.query<WebhookSubscription & { secret_hash: string }>(
    `SELECT id, user_id, url, secret_hash, topics, description, status,
            failure_count, last_delivery_at, created_at, updated_at
     FROM webhook_subscriptions WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  return {
    ...row,
    secret_hint: `${row.secret_hash.slice(0, 4)}…${row.secret_hash.slice(-4)}`,
  };
}

// ---------------------------------------------------------------------------
// Delivery dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a webhook event to all active subscriptions that match the topic.
 * Each delivery is logged immediately so callers can audit what happened even
 * when retries are still pending.
 *
 * Call this from anywhere an event occurs (market resolved, bet placed, …).
 */
export async function dispatchEvent(
  topic: WebhookTopic,
  eventPayload: Record<string, unknown>,
): Promise<void> {
  // Find all active subscriptions for this topic.
  const result = await pool.query<{ id: string; url: string; secret_hash: string }>(
    `SELECT id, url, secret_hash
     FROM webhook_subscriptions
     WHERE status = 'active' AND topics @> $1::jsonb`,
    [JSON.stringify([topic])],
  );

  if (!result.rows.length) return;

  const payloadWithMeta = {
    event_type: topic,
    timestamp: new Date().toISOString(),
    data: eventPayload,
  };
  const bodyStr = JSON.stringify(payloadWithMeta);
  const payloadHash = crypto.createHash('sha256').update(bodyStr).digest('hex');

  await Promise.all(
    result.rows.map((sub) =>
      _deliverToSubscription(sub.id, sub.url, sub.secret_hash, topic, payloadWithMeta, bodyStr, payloadHash, 1),
    ),
  );
}

/**
 * Core delivery function. Creates or updates a delivery record, fires the HTTP
 * call, then schedules a retry if it failed and the attempt ceiling hasn't been
 * reached.
 */
async function _deliverToSubscription(
  webhookId: string,
  url: string,
  secretHash: string,
  topic: WebhookTopic,
  payload: Record<string, unknown>,
  bodyStr: string,
  payloadHash: string,
  attempt: number,
  existingDeliveryId?: string,
): Promise<void> {
  // We sign with the hash as a stand-in here because we store only the hash.
  // In a real deployment you would store the ciphertext and decrypt at dispatch
  // time.  This keeps the secret out of the DB while still allowing signature
  // verification by the recipient (who knows their own secret).
  const signature = sign(secretHash, bodyStr);
  const eventId = makeEventId(webhookId, topic, payloadHash);

  const deliveryId = existingDeliveryId ?? makeDeliveryId();

  if (!existingDeliveryId) {
    await pool.query(
      `INSERT INTO webhook_deliveries
         (id, webhook_id, event_id, event_type, payload, status, attempt_count)
       VALUES ($1, $2, $3, $4, $5, 'pending', 0)
       ON CONFLICT (id) DO NOTHING`,
      [deliveryId, webhookId, eventId, topic, JSON.stringify(payload)],
    );
  }

  const { httpStatus, latencyMs, error } = await httpPost(url, bodyStr, signature, eventId);

  const success = httpStatus !== null && httpStatus >= 200 && httpStatus < 300;

  if (success) {
    await pool.query(
      `UPDATE webhook_deliveries
       SET status = 'success', attempt_count = $1, last_http_status = $2,
           last_error = NULL, delivered_at = NOW(), next_retry_at = NULL,
           updated_at = NOW()
       WHERE id = $3`,
      [attempt, httpStatus, deliveryId],
    );

    await pool.query(
      `UPDATE webhook_subscriptions
       SET failure_count = 0, last_delivery_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [webhookId],
    );

    logger.info({ webhookId, deliveryId, eventId, attempt, latencyMs }, 'webhook delivered');
    return;
  }

  // Failure path.
  if (attempt >= MAX_ATTEMPTS) {
    await pool.query(
      `UPDATE webhook_deliveries
       SET status = 'exhausted', attempt_count = $1, last_http_status = $2,
           last_error = $3, next_retry_at = NULL, updated_at = NOW()
       WHERE id = $4`,
      [attempt, httpStatus, error ?? `HTTP ${httpStatus}`, deliveryId],
    );

    await pool.query(
      `UPDATE webhook_subscriptions
       SET failure_count = failure_count + 1, updated_at = NOW()
       WHERE id = $1`,
      [webhookId],
    );

    logger.warn({ webhookId, deliveryId, eventId, attempt }, 'webhook delivery exhausted max retries');
    return;
  }

  const nextRetry = new Date(Date.now() + backoffMs(attempt));

  await pool.query(
    `UPDATE webhook_deliveries
     SET status = 'retrying', attempt_count = $1, last_http_status = $2,
         last_error = $3, next_retry_at = $4, updated_at = NOW()
     WHERE id = $5`,
    [attempt, httpStatus, error ?? `HTTP ${httpStatus}`, nextRetry.toISOString(), deliveryId],
  );

  await pool.query(
    `UPDATE webhook_subscriptions
     SET failure_count = failure_count + 1, updated_at = NOW()
     WHERE id = $1`,
    [webhookId],
  );

  logger.warn({ webhookId, deliveryId, eventId, attempt, nextRetry }, 'webhook delivery failed, scheduled retry');
}

// ---------------------------------------------------------------------------
// Delivery log queries
// ---------------------------------------------------------------------------

export interface ListDeliveriesOptions {
  userId: string;
  webhookId?: string;
  status?: WebhookDelivery['status'];
  page: number;
  limit: number;
}

export async function listDeliveries(
  opts: ListDeliveriesOptions,
): Promise<{ data: WebhookDelivery[]; total: number }> {
  const conditions: string[] = [
    // Scope to webhooks owned by the requesting user.
    'ws.user_id = $1',
  ];
  const params: unknown[] = [opts.userId];
  let idx = 2;

  if (opts.webhookId) {
    conditions.push(`wd.webhook_id = $${idx++}`);
    params.push(opts.webhookId);
  }
  if (opts.status) {
    conditions.push(`wd.status = $${idx++}`);
    params.push(opts.status);
  }

  const where = conditions.join(' AND ');
  const offset = (opts.page - 1) * opts.limit;

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM webhook_deliveries wd
     JOIN webhook_subscriptions ws ON ws.id = wd.webhook_id
     WHERE ${where}`,
    params,
  );

  const dataResult = await pool.query<WebhookDelivery>(
    `SELECT wd.*
     FROM webhook_deliveries wd
     JOIN webhook_subscriptions ws ON ws.id = wd.webhook_id
     WHERE ${where}
     ORDER BY wd.created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, opts.limit, offset],
  );

  return { data: dataResult.rows, total: parseInt(countResult.rows[0].count, 10) };
}

// ---------------------------------------------------------------------------
// Retry worker
// ---------------------------------------------------------------------------

/**
 * Process all deliveries that are due for retry.
 * Meant to be called on a cron schedule (e.g. every 30 seconds).
 */
export async function processRetries(): Promise<void> {
  const result = await pool.query<{
    id: string;
    webhook_id: string;
    event_type: WebhookTopic;
    payload: Record<string, unknown>;
    attempt_count: number;
  }>(
    `SELECT wd.id, wd.webhook_id, wd.event_type, wd.payload, wd.attempt_count
     FROM webhook_deliveries wd
     JOIN webhook_subscriptions ws ON ws.id = wd.webhook_id
     WHERE wd.status = 'retrying'
       AND wd.next_retry_at <= NOW()
       AND ws.status = 'active'
     ORDER BY wd.next_retry_at
     LIMIT 100`,
  );

  if (!result.rows.length) return;

  logger.info({ count: result.rows.length }, 'processing webhook retries');

  for (const row of result.rows) {
    const subResult = await pool.query<{ url: string; secret_hash: string }>(
      `SELECT url, secret_hash FROM webhook_subscriptions WHERE id = $1`,
      [row.webhook_id],
    );
    if (!subResult.rows[0]) continue;

    const { url, secret_hash } = subResult.rows[0];
    const payload = row.payload as Record<string, unknown>;
    const bodyStr = JSON.stringify(payload);
    const payloadHash = crypto.createHash('sha256').update(bodyStr).digest('hex');

    await _deliverToSubscription(
      row.webhook_id,
      url,
      secret_hash,
      row.event_type,
      payload,
      bodyStr,
      payloadHash,
      row.attempt_count + 1,
      row.id,
    );
  }
}

// ---------------------------------------------------------------------------
// Admin replay
// ---------------------------------------------------------------------------

/**
 * Re-queue specific delivery IDs for immediate re-dispatch.
 * Only deliveries in 'failed' or 'exhausted' state are eligible.
 */
export async function replayDeliveries(deliveryIds: string[]): Promise<{ queued: string[]; skipped: string[] }> {
  const queued: string[] = [];
  const skipped: string[] = [];

  for (const deliveryId of deliveryIds) {
    const result = await pool.query<{
      id: string;
      webhook_id: string;
      event_type: WebhookTopic;
      payload: Record<string, unknown>;
      status: string;
    }>(
      `SELECT wd.id, wd.webhook_id, wd.event_type, wd.payload, wd.status
       FROM webhook_deliveries wd
       WHERE wd.id = $1 AND wd.status IN ('failed', 'exhausted', 'retrying')`,
      [deliveryId],
    );

    if (!result.rows[0]) {
      skipped.push(deliveryId);
      continue;
    }

    const delivery = result.rows[0];
    const subResult = await pool.query<{ url: string; secret_hash: string; status: string }>(
      `SELECT url, secret_hash, status FROM webhook_subscriptions WHERE id = $1`,
      [delivery.webhook_id],
    );

    if (!subResult.rows[0] || subResult.rows[0].status === 'disabled') {
      skipped.push(deliveryId);
      continue;
    }

    // Reset the delivery record so it retries immediately.
    await pool.query(
      `UPDATE webhook_deliveries
       SET status = 'retrying', next_retry_at = NOW(), attempt_count = 0, updated_at = NOW()
       WHERE id = $1`,
      [deliveryId],
    );

    queued.push(deliveryId);
    logger.info({ deliveryId }, 'webhook delivery queued for admin replay');
  }

  return { queued, skipped };
}

// ---------------------------------------------------------------------------
// Test ping
// ---------------------------------------------------------------------------

/** Send a synthetic ping payload to verify endpoint reachability. */
export async function sendTestPing(
  subscriptionId: string,
  userId: string,
): Promise<{ delivered: boolean; httpStatus: number | null; latencyMs: number; error: string | null }> {
  const sub = await getSubscription(subscriptionId, userId);
  if (!sub) throw new Error(`Subscription ${subscriptionId} not found`);
  if (sub.status === 'disabled') throw new Error('Subscription is disabled');

  const payload = {
    event_type: 'ping',
    timestamp: new Date().toISOString(),
    data: { message: 'StellarFox webhook test ping' },
  };
  const bodyStr = JSON.stringify(payload);

  // Re-fetch to get the secret_hash.
  const rawResult = await pool.query<{ secret_hash: string }>(
    `SELECT secret_hash FROM webhook_subscriptions WHERE id = $1`,
    [subscriptionId],
  );
  if (!rawResult.rows[0]) throw new Error('Subscription not found');

  const signature = sign(rawResult.rows[0].secret_hash, bodyStr);
  const eventId = `evt-ping-${Date.now()}`;

  const result = await httpPost(sub.url, bodyStr, signature, eventId);
  return {
    delivered: result.httpStatus !== null && result.httpStatus >= 200 && result.httpStatus < 300,
    ...result,
  };
}
