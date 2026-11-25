/**
 * Connection Pool Prometheus Metrics
 *
 * Registers pool-specific gauges, counters, and histograms against the shared
 * prom-client register so they appear alongside the existing app metrics at
 * GET /metrics.
 */

import { Gauge, Counter, Histogram, register } from 'prom-client';

// ── Pool size gauges ──────────────────────────────────────────────────────────

/** Current number of clients checked out of the pool. */
export const poolActiveConnections = new Gauge({
  name: 'db_pool_active_connections',
  help: 'Number of database connections currently checked out',
  registers: [register],
});

/** Current number of idle clients waiting in the pool. */
export const poolIdleConnections = new Gauge({
  name: 'db_pool_idle_connections',
  help: 'Number of database connections sitting idle in the pool',
  registers: [register],
});

/** Current number of callers queued waiting for a free connection. */
export const poolWaitingRequests = new Gauge({
  name: 'db_pool_waiting_requests',
  help: 'Number of requests queued waiting for a free database connection',
  registers: [register],
});

/** Configured maximum pool size (may change when the pool is reconfigured). */
export const poolMaxSize = new Gauge({
  name: 'db_pool_max_size',
  help: 'Configured maximum number of database connections in the pool',
  registers: [register],
});

/** Utilisation as a ratio 0–1 (active / max). */
export const poolUtilization = new Gauge({
  name: 'db_pool_utilization_ratio',
  help: 'Fraction of pool connections currently in use (active / max)',
  registers: [register],
});

// ── Lifecycle counters ────────────────────────────────────────────────────────

/** Total pool connections established since process start. */
export const poolConnectionsAcquired = new Counter({
  name: 'db_pool_connections_acquired_total',
  help: 'Total number of connections acquired from the pool since startup',
  registers: [register],
});

/** Total pool connections released back to the pool since process start. */
export const poolConnectionsReleased = new Counter({
  name: 'db_pool_connections_released_total',
  help: 'Total number of connections released back to the pool since startup',
  registers: [register],
});

/** Total pool connections destroyed (idle-timeout, error, manual cull). */
export const poolConnectionsDestroyed = new Counter({
  name: 'db_pool_connections_destroyed_total',
  help: 'Total number of pool connections destroyed',
  labelNames: ['reason'] as const,
  registers: [register],
});

/** Total connection acquisition errors (timeout, refused, etc.). */
export const poolConnectionErrors = new Counter({
  name: 'db_pool_connection_errors_total',
  help: 'Total number of connection acquisition errors',
  labelNames: ['type'] as const,
  registers: [register],
});

/** Total self-healing actions triggered. */
export const poolSelfHealActions = new Counter({
  name: 'db_pool_self_heal_actions_total',
  help: 'Total number of automated self-healing actions taken on the pool',
  labelNames: ['action'] as const,
  registers: [register],
});

/** Total automated pool size adjustments. */
export const poolResizeEvents = new Counter({
  name: 'db_pool_resize_events_total',
  help: 'Total number of times the pool max-size was automatically adjusted',
  labelNames: ['direction'] as const, // 'scale_up' | 'scale_down'
  registers: [register],
});

// ── Wait-time histogram ───────────────────────────────────────────────────────

/** How long callers waited to acquire a connection (seconds). */
export const poolAcquireWaitDuration = new Histogram({
  name: 'db_pool_acquire_wait_duration_seconds',
  help: 'Time spent waiting to acquire a database connection from the pool',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

/** How long a connection was held by a caller before being released (seconds). */
export const poolConnectionHoldDuration = new Histogram({
  name: 'db_pool_connection_hold_duration_seconds',
  help: 'Time a caller held a database connection before releasing it',
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});
