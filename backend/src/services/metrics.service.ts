import { Counter, Histogram, Gauge, Summary, register, collectDefaultMetrics } from 'prom-client';

// Collect default Node.js metrics (GC, event loop, memory, etc.)
collectDefaultMetrics({ register });

register.setDefaultLabels({ app: 'bankerchanger' });

// ════════════════════════════════════════════════════════════════════════════
// ── HTTP Request Metrics ──────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

/** Histogram tracking HTTP request duration in seconds, labeled by method, route, and status code. */
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});

/** Counter tracking total HTTP requests, labeled by method, route, and status code. */
export const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
});

/**
 * Counter for slow HTTP requests (those exceeding the SLOW_REQUEST_THRESHOLD_MS).
 * Labeled by method and route to identify problematic endpoints.
 */
export const slowRequestsTotal = new Counter({
  name: 'http_slow_requests_total',
  help: 'Total number of HTTP requests that exceeded the slow-request threshold',
  labelNames: ['method', 'route'] as const,
});

// ════════════════════════════════════════════════════════════════════════════
// ── Database Metrics ──────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

/** Histogram tracking database query duration in seconds, labeled by operation (select, insert, update, delete). */
export const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
});

/** Counter for slow database queries (those exceeding SLOW_QUERY_THRESHOLD_MS). */
export const slowDbQueriesTotal = new Counter({
  name: 'db_slow_queries_total',
  help: 'Total number of database queries that exceeded the slow-query threshold',
  labelNames: ['operation'] as const,
});

/** Gauge tracking the current size of the database connection pool. */
export const dbConnectionPoolSize = new Gauge({
  name: 'db_connection_pool_size',
  help: 'Current number of connections in the database pool',
});

/** Gauge tracking available connections in the database pool. */
export const dbConnectionPoolAvailable = new Gauge({
  name: 'db_connection_pool_available',
  help: 'Number of available connections in the database pool',
});

// ════════════════════════════════════════════════════════════════════════════
// ── Redis / Cache Metrics ─────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

/** Counter tracking Redis cache hits. */
export const cacheHitsTotal = new Counter({
  name: 'cache_hits_total',
  help: 'Total number of Redis cache hits',
  labelNames: ['cache_key'] as const,
});

/** Counter tracking Redis cache misses. */
export const cacheMissesTotal = new Counter({
  name: 'cache_misses_total',
  help: 'Total number of Redis cache misses',
  labelNames: ['cache_key'] as const,
});

/** Histogram tracking Redis operation duration. */
export const redisOperationDuration = new Histogram({
  name: 'redis_operation_duration_seconds',
  help: 'Duration of Redis operations in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
});

/** Gauge tracking Redis connection pool size. */
export const redisConnectionPoolSize = new Gauge({
  name: 'redis_connection_pool_size',
  help: 'Current number of connections in the Redis pool',
});

// ════════════════════════════════════════════════════════════════════════════
// ── WebSocket Metrics ─────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

/** Gauge tracking the number of active WebSocket connections. */
export const activeWebSocketConnections = new Gauge({
  name: 'websocket_active_connections',
  help: 'Number of currently active WebSocket connections',
});

/** Counter tracking WebSocket message sends. */
export const webSocketMessagesSent = new Counter({
  name: 'websocket_messages_sent_total',
  help: 'Total number of WebSocket messages sent',
  labelNames: ['message_type'] as const,
});

/** Counter tracking WebSocket message receives. */
export const webSocketMessagesReceived = new Counter({
  name: 'websocket_messages_received_total',
  help: 'Total number of WebSocket messages received',
  labelNames: ['message_type'] as const,
});

// ════════════════════════════════════════════════════════════════════════════
// ── Business Metrics: Markets ─────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

/** Counter tracking created markets. */
export const marketsCreatedTotal = new Counter({
  name: 'markets_created_total',
  help: 'Total number of markets created',
});

/** Gauge tracking active markets count. */
export const activeMarketsGauge = new Gauge({
  name: 'active_markets',
  help: 'Number of currently active markets',
});

/** Gauge tracking resolved markets count. */
export const resolvedMarketsGauge = new Gauge({
  name: 'resolved_markets',
  help: 'Number of resolved markets',
});

/** Gauge tracking disputed markets count. */
export const disputedMarketsGauge = new Gauge({
  name: 'disputed_markets',
  help: 'Number of disputed markets',
});

/** Histogram tracking market resolution latency (time from lock to resolution). */
export const marketResolutionLatency = new Histogram({
  name: 'market_resolution_latency_seconds',
  help: 'Latency of market resolution in seconds',
  buckets: [1, 5, 10, 30, 60, 300, 600, 1800, 3600],
});

// ════════════════════════════════════════════════════════════════════════════
// ── Business Metrics: Bets ────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

/** Counter tracking bets placed. */
export const betsPlacedTotal = new Counter({
  name: 'bets_placed_total',
  help: 'Total number of bets placed',
  labelNames: ['outcome'] as const,
});

/** Gauge tracking total amount wagered (in XLM). */
export const totalWageredXlm = new Gauge({
  name: 'total_wagered_xlm',
  help: 'Total amount wagered in XLM',
});

/** Gauge tracking average bet size (in XLM). */
export const averageBetSizeXlm = new Gauge({
  name: 'average_bet_size_xlm',
  help: 'Average bet size in XLM',
});

/** Counter tracking successful bet payouts. */
export const betPayoutsTotal = new Counter({
  name: 'bet_payouts_total',
  help: 'Total number of successful bet payouts',
});

/** Counter tracking failed bet payouts. */
export const betPayoutFailuresTotal = new Counter({
  name: 'bet_payout_failures_total',
  help: 'Total number of failed bet payouts',
});

/** Gauge tracking total amount paid out (in XLM). */
export const totalPaidOutXlm = new Gauge({
  name: 'total_paid_out_xlm',
  help: 'Total amount paid out in XLM',
});

// ════════════════════════════════════════════════════════════════════════════
// ── Business Metrics: Users ───────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

/** Counter tracking new user registrations. */
export const usersRegisteredTotal = new Counter({
  name: 'users_registered_total',
  help: 'Total number of users registered',
});

/** Gauge tracking active users count. */
export const activeUsersGauge = new Gauge({
  name: 'active_users',
  help: 'Number of currently active users',
});

/** Gauge tracking total registered users. */
export const totalUsersGauge = new Gauge({
  name: 'total_users',
  help: 'Total number of registered users',
});

/** Counter tracking user authentication failures. */
export const userAuthFailuresTotal = new Counter({
  name: 'user_auth_failures_total',
  help: 'Total number of user authentication failures',
  labelNames: ['reason'] as const,
});

// ════════════════════════════════════════════════════════════════════════════
// ── Blockchain & Smart Contract Metrics ───────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

/** Counter tracking successful contract invocations. */
export const contractInvocationsTotal = new Counter({
  name: 'contract_invocations_total',
  help: 'Total number of contract invocations',
  labelNames: ['contract', 'operation'] as const,
});

/** Counter tracking failed contract invocations. */
export const contractInvocationFailuresTotal = new Counter({
  name: 'contract_invocation_failures_total',
  help: 'Total number of failed contract invocations',
  labelNames: ['contract', 'operation', 'error_type'] as const,
});

/** Histogram tracking contract invocation latency. */
export const contractInvocationLatency = new Histogram({
  name: 'contract_invocation_latency_seconds',
  help: 'Latency of contract invocations in seconds',
  labelNames: ['contract', 'operation'] as const,
  buckets: [0.5, 1, 2, 5, 10, 30],
});

/** Gauge tracking transaction fee costs (in XLM). */
export const transactionFeeCost = new Gauge({
  name: 'transaction_fee_cost_xlm',
  help: 'Last transaction fee cost in XLM',
});

// ════════════════════════════════════════════════════════════════════════════
// ── Error & Exception Metrics ─────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

/** Counter tracking application errors by type. */
export const applicationsErrorsTotal = new Counter({
  name: 'application_errors_total',
  help: 'Total number of application errors',
  labelNames: ['error_type', 'route'] as const,
});

/** Counter tracking database errors. */
export const databaseErrorsTotal = new Counter({
  name: 'database_errors_total',
  help: 'Total number of database errors',
  labelNames: ['error_type'] as const,
});

/** Counter tracking external service errors. */
export const externalServiceErrorsTotal = new Counter({
  name: 'external_service_errors_total',
  help: 'Total number of external service errors',
  labelNames: ['service'] as const,
});

// ── Cron Job Metrics (existing) ───────────────────────────────────────────────

export const cronSessionsDeleted = new Counter({
  name: 'cron_sessions_deleted_total',
  help: 'Total expired user_sessions rows deleted by cleanup cron',
});

export const cronResetTokensDeleted = new Counter({
  name: 'cron_reset_tokens_deleted_total',
  help: 'Total expired password_reset_tokens rows deleted by cleanup cron',
});

export const cronPredictionsDeleted = new Counter({
  name: 'cron_predictions_deleted_total',
  help: 'Total expired prediction rows deleted by cleanup cron',
});

export const cronNotificationsSoftDeleted = new Counter({
  name: 'cron_notifications_soft_deleted_total',
  help: 'Total notification_jobs rows soft-deleted by cleanup cron',
});

export const cronDistributionsArchived = new Counter({
  name: 'cron_distributions_archived_total',
  help: 'Total failed distributions rows archived by cleanup cron',
});

export const cronBlockchainEventsDeleted = new Counter({
  name: 'cron_blockchain_events_deleted_total',
  help: 'Total processed blockchain_events rows deleted by cleanup cron',
});

// ════════════════════════════════════════════════════════════════════════════
// ── Indexer Metrics (Blockchain Event Processing) ────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

/** Counter tracking blockchain events processed. */
export const blockchainEventsProcessedTotal = new Counter({
  name: 'blockchain_events_processed_total',
  help: 'Total number of blockchain events processed',
  labelNames: ['event_type', 'status'] as const,
});

/** Histogram tracking blockchain event processing latency. */
export const blockchainEventProcessingLatency = new Histogram({
  name: 'blockchain_event_processing_latency_seconds',
  help: 'Latency of blockchain event processing in seconds',
  labelNames: ['event_type'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10],
});

/** Gauge tracking the depth of the blockchain event queue. */
export const blockchainEventQueueDepth = new Gauge({
  name: 'blockchain_event_queue_depth',
  help: 'Number of blockchain events pending processing',
});

/** Counter tracking blockchain event processing errors. */
export const blockchainEventProcessingErrorsTotal = new Counter({
  name: 'blockchain_event_processing_errors_total',
  help: 'Total number of blockchain event processing errors',
  labelNames: ['event_type', 'error_type'] as const,
});

/** Gauge tracking the last processed ledger sequence. */
export const lastProcessedLedger = new Gauge({
  name: 'last_processed_ledger_sequence',
  help: 'Last processed ledger sequence number',
});

/** Gauge tracking the current polling interval. */
export const pollingIntervalMs = new Gauge({
  name: 'polling_interval_ms',
  help: 'Current polling interval in milliseconds',
});

/** Counter tracking ledger continuity breaks. */
export const ledgerContinuityBreaksTotal = new Counter({
  name: 'ledger_continuity_breaks_total',
  help: 'Total number of ledger continuity breaks detected',
});

// ════════════════════════════════════════════════════════════════════════════
// ── Resource Utilization Metrics ──────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

/** Gauge tracking memory usage percentage. */
export const memoryUsagePercent = new Gauge({
  name: 'memory_usage_percent',
  help: 'Memory usage as a percentage of available memory',
});

/** Gauge tracking CPU usage percentage. */
export const cpuUsagePercent = new Gauge({
  name: 'cpu_usage_percent',
  help: 'CPU usage as a percentage',
});

/** Gauge tracking event loop lag in milliseconds. */
export const eventLoopLagMs = new Gauge({
  name: 'event_loop_lag_ms',
  help: 'Event loop lag in milliseconds',
});

export type MetricsExportFormat = 'json' | 'csv';

function escapeCsv(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export async function exportMetrics(format: MetricsExportFormat): Promise<string> {
  const metrics = await register.getMetricsAsJSON();
  if (format === 'json') return JSON.stringify(metrics);

  const rows = ['name,type,help,labels,value'];
  for (const metric of metrics) {
    for (const sample of metric.values) {
      rows.push([
        metric.name,
        metric.type,
        metric.help,
        JSON.stringify(sample.labels),
        String(sample.value),
      ].map(escapeCsv).join(','));
    }
  }
  return rows.join('\r\n');
}

export { register };

// ════════════════════════════════════════════════════════════════════════════
// ── Thresholds ────────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

/** Requests taking longer than this (ms) are counted as slow and logged. */
export const SLOW_REQUEST_THRESHOLD_MS = 1000;

/** DB queries taking longer than this (ms) are counted as slow and logged. */
export const SLOW_QUERY_THRESHOLD_MS = 500;

