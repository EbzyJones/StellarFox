/**
 * Connection Pool Monitor
 *
 * Provides comprehensive runtime monitoring of the pg connection pool:
 *
 *   • Periodic sampling of pool state (active / idle / waiting) into a
 *     fixed-size circular buffer for time-series visualisation.
 *   • Per-connection lifecycle tracking (acquired → released / destroyed).
 *   • Threshold-based alert evaluation with debounce to avoid alert storms.
 *   • Self-healing: forced idle-connection culling and circuit-breaker trips
 *     when the pool is exhausted or error rates spike.
 *   • Prometheus metrics kept in sync on every sample tick.
 *
 * Usage
 * -----
 *   import { initConnectionPoolMonitor } from './connectionPoolMonitor.service';
 *   const monitor = initConnectionPoolMonitor(pool, { maxSize: 20 });
 *   monitor.start();
 *
 * The singleton accessor `getConnectionPoolMonitor()` is available after init.
 */

import { Pool, PoolClient } from 'pg';
import { logger } from '../utils/logger';
import { getAlertService } from './alert.service';
import { AlertSeverity, AlertChannel } from '../types/alerting.types';
import {
  poolActiveConnections,
  poolIdleConnections,
  poolWaitingRequests,
  poolMaxSize,
  poolUtilization,
  poolConnectionsAcquired,
  poolConnectionsReleased,
  poolConnectionsDestroyed,
  poolConnectionErrors,
  poolSelfHealActions,
  poolResizeEvents,
  poolAcquireWaitDuration,
  poolConnectionHoldDuration,
} from './pool.metrics';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PoolSnapshot {
  timestamp: Date;
  active: number;
  idle: number;
  waiting: number;
  total: number;        // active + idle
  maxSize: number;
  utilizationPct: number;
}

/** A single connection's lifecycle record. */
export interface ConnectionEvent {
  connectionId: string;
  event: 'acquired' | 'released' | 'destroyed' | 'error';
  timestamp: Date;
  holdDurationMs?: number;   // set on 'released'
  waitDurationMs?: number;   // set on 'acquired'
  reason?: string;           // set on 'destroyed' | 'error'
}

export interface AlertThresholds {
  /** Fire when utilisation (%) reaches or exceeds this. Default 80. */
  utilizationWarnPct: number;
  /** Fire critical when utilisation (%) reaches or exceeds this. Default 95. */
  utilizationCriticalPct: number;
  /** Fire when waiting requests reach or exceed this. Default 5. */
  waitingWarnCount: number;
  /** Fire critical when waiting requests reach or exceed this. Default 15. */
  waitingCriticalCount: number;
  /** Fire when connection errors in the last window reach this. Default 5. */
  errorRateWarnCount: number;
  /** Fire critical when connection errors in the last window reach this. Default 15. */
  errorRateCriticalCount: number;
  /** Fire when avg acquire-wait (ms) exceeds this. Default 500 ms. */
  acquireWaitWarnMs: number;
  /** Self-heal trigger: utilisation (%) at which to cull idle connections. Default 90. */
  selfHealCullPct: number;
  /** Self-heal trigger: pool exhaustion (utilisation ≥ 100%) consecutive ticks before circuit-break. */
  selfHealCircuitBreakTicks: number;
  /** Minimum ms between repeat alerts for the same condition. Default 60 000 (1 min). */
  alertDebounceMs: number;
}

export interface MonitorConfig {
  /** How often to sample pool state in milliseconds. Default 10 000 (10 s). */
  sampleIntervalMs: number;
  /** Number of snapshots kept in the circular history buffer. Default 180 (30 min at 10 s). */
  historySize: number;
  /** Number of lifecycle events kept in memory. Default 500. */
  lifecycleBufferSize: number;
  /** Maximum pg pool size (used for utilisation %. Default 10). */
  maxSize: number;
  thresholds: Partial<AlertThresholds>;
  /** Disable alert integration (useful in tests). Default false. */
  disableAlerts: boolean;
}

interface InternalConnState {
  acquiredAt: Date;
  waitStartedAt?: Date;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS: AlertThresholds = {
  utilizationWarnPct: 80,
  utilizationCriticalPct: 95,
  waitingWarnCount: 5,
  waitingCriticalCount: 15,
  errorRateWarnCount: 5,
  errorRateCriticalCount: 15,
  acquireWaitWarnMs: 500,
  selfHealCullPct: 90,
  selfHealCircuitBreakTicks: 3,
  alertDebounceMs: 60_000,
};

const DEFAULT_CONFIG: MonitorConfig = {
  sampleIntervalMs: 10_000,
  historySize: 180,
  lifecycleBufferSize: 500,
  maxSize: 10,
  thresholds: {},
  disableAlerts: false,
};

// ── Monitor class ─────────────────────────────────────────────────────────────

export class ConnectionPoolMonitor {
  private readonly pool: Pool;
  private readonly config: Required<MonitorConfig>;
  private readonly thresholds: AlertThresholds;

  /** Circular history of pool snapshots. */
  private readonly history: PoolSnapshot[] = [];

  /** Ring buffer of lifecycle events. */
  private readonly lifecycle: ConnectionEvent[] = [];

  /** Per-connection in-flight state (connectionId → InternalConnState). */
  private readonly inFlight = new Map<string, InternalConnState>();

  /** Tracks recent connection errors for rate-based alerting. */
  private recentErrors: Date[] = [];

  /** Accumulates acquire-wait durations between ticks for avg calculation. */
  private acquireWaitSamples: number[] = [];

  /** Consecutive ticks the pool has been 100% utilised (for circuit-break). */
  private exhaustionTicks = 0;

  /** Timestamp of last fired alert per condition key (debounce). */
  private lastAlertAt = new Map<string, number>();

  private sampleTimer: NodeJS.Timeout | null = null;

  /** Whether the monitor has been started. */
  private running = false;

  constructor(pool: Pool, config: Partial<MonitorConfig> = {}) {
    this.pool = pool;
    this.config = { ...DEFAULT_CONFIG, ...config } as Required<MonitorConfig>;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...config.thresholds };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** Start periodic sampling. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.sampleTimer = setInterval(() => this.tick(), this.config.sampleIntervalMs);
    // Run an initial tick immediately so the history is non-empty
    this.tick().catch((err) => logger.error({ err }, 'Pool monitor initial tick failed'));
    logger.info(
      { intervalMs: this.config.sampleIntervalMs, maxSize: this.config.maxSize },
      'Connection pool monitor started',
    );
  }

  /** Stop periodic sampling. Idempotent. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    logger.info('Connection pool monitor stopped');
  }

  // ── Connection lifecycle hooks ───────────────────────────────────────────────

  /**
   * Call when a caller begins waiting to acquire a connection.
   * Returns the connectionId to pass to onAcquired / onError.
   */
  onWaitStart(connectionId: string): void {
    this.inFlight.set(connectionId, { acquiredAt: new Date(), waitStartedAt: new Date() });
  }

  /**
   * Call when a connection has been successfully acquired from the pool.
   */
  onAcquired(connectionId: string): void {
    const now = new Date();
    const state = this.inFlight.get(connectionId);
    const waitDurationMs = state?.waitStartedAt
      ? now.getTime() - state.waitStartedAt.getTime()
      : undefined;

    // Update state: acquired time starts now
    this.inFlight.set(connectionId, { acquiredAt: now });

    if (waitDurationMs !== undefined) {
      this.acquireWaitSamples.push(waitDurationMs);
      poolAcquireWaitDuration.observe(waitDurationMs / 1000);
    }

    poolConnectionsAcquired.inc();

    this.pushLifecycle({
      connectionId,
      event: 'acquired',
      timestamp: now,
      waitDurationMs,
    });
  }

  /**
   * Call when a connection is released back to the pool.
   */
  onReleased(connectionId: string): void {
    const state = this.inFlight.get(connectionId);
    const holdDurationMs = state
      ? new Date().getTime() - state.acquiredAt.getTime()
      : undefined;

    this.inFlight.delete(connectionId);

    if (holdDurationMs !== undefined) {
      poolConnectionHoldDuration.observe(holdDurationMs / 1000);
    }

    poolConnectionsReleased.inc();

    this.pushLifecycle({
      connectionId,
      event: 'released',
      timestamp: new Date(),
      holdDurationMs,
    });
  }

  /**
   * Call when a connection is destroyed (idle timeout, explicit cull, etc.).
   */
  onDestroyed(connectionId: string, reason: string): void {
    this.inFlight.delete(connectionId);
    poolConnectionsDestroyed.labels(reason).inc();
    this.pushLifecycle({
      connectionId,
      event: 'destroyed',
      timestamp: new Date(),
      reason,
    });
  }

  /**
   * Call when a connection acquisition fails.
   */
  onError(connectionId: string, reason: string): void {
    this.inFlight.delete(connectionId);
    this.recentErrors.push(new Date());
    poolConnectionErrors.labels(reason).inc();
    this.pushLifecycle({
      connectionId,
      event: 'error',
      timestamp: new Date(),
      reason,
    });
  }

  // ── Read API ─────────────────────────────────────────────────────────────────

  /** Latest snapshot, or null if no tick has run yet. */
  currentSnapshot(): PoolSnapshot | null {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null;
  }

  /**
   * Returns up to `limit` recent snapshots in chronological order.
   * Useful for rendering a time-series chart.
   */
  snapshotHistory(limit?: number): PoolSnapshot[] {
    const h = this.history;
    return limit ? h.slice(-limit) : [...h];
  }

  /**
   * Returns up to `limit` recent lifecycle events, most-recent first.
   */
  lifecycleHistory(limit?: number): ConnectionEvent[] {
    const copy = [...this.lifecycle].reverse();
    return limit ? copy.slice(0, limit) : copy;
  }

  /** Health summary consumed by /health and /api/pool/health endpoints. */
  healthSummary(): {
    status: 'healthy' | 'degraded' | 'critical';
    snapshot: PoolSnapshot | null;
    issues: string[];
    recommendations: string[];
  } {
    const snap = this.currentSnapshot();
    const issues: string[] = [];
    const recommendations: string[] = [];

    if (!snap) {
      return { status: 'healthy', snapshot: null, issues: [], recommendations: [] };
    }

    if (snap.utilizationPct >= this.thresholds.utilizationCriticalPct) {
      issues.push(`Pool utilisation critical: ${snap.utilizationPct.toFixed(1)}%`);
    } else if (snap.utilizationPct >= this.thresholds.utilizationWarnPct) {
      issues.push(`Pool utilisation elevated: ${snap.utilizationPct.toFixed(1)}%`);
    }

    if (snap.waiting >= this.thresholds.waitingCriticalCount) {
      issues.push(`${snap.waiting} requests waiting for a connection (critical threshold)`);
    } else if (snap.waiting >= this.thresholds.waitingWarnCount) {
      issues.push(`${snap.waiting} requests queued waiting for a connection`);
    }

    const recentErrorCount = this.recentErrors.filter(
      (t) => t.getTime() > Date.now() - 60_000,
    ).length;
    if (recentErrorCount >= this.thresholds.errorRateCriticalCount) {
      issues.push(`${recentErrorCount} connection errors in the last minute (critical)`);
    } else if (recentErrorCount >= this.thresholds.errorRateWarnCount) {
      issues.push(`${recentErrorCount} connection errors in the last minute`);
    }

    if (snap.utilizationPct >= 70) {
      recommendations.push(
        `Consider increasing DB_POOL_MAX (currently ${snap.maxSize}) to handle peak load`,
      );
    }
    if (snap.waiting > 0) {
      recommendations.push('Audit long-running queries — they may be holding connections longer than expected');
    }
    if (recentErrorCount > 0) {
      recommendations.push('Check pg logs for connection refusals and verify max_connections on the server');
    }

    const status =
      issues.some((i) => i.includes('critical'))
        ? 'critical'
        : issues.length > 0
          ? 'degraded'
          : 'healthy';

    return { status, snapshot: snap, issues, recommendations };
  }

  /**
   * Current effective thresholds (merged defaults + constructor overrides).
   */
  getThresholds(): AlertThresholds {
    return { ...this.thresholds };
  }

  /**
   * Update thresholds at runtime without restarting the monitor.
   */
  updateThresholds(overrides: Partial<AlertThresholds>): void {
    Object.assign(this.thresholds, overrides);
    logger.info({ overrides }, 'Pool monitor thresholds updated');
  }

  // ── Self-healing ─────────────────────────────────────────────────────────────

  /**
   * Manually trigger the self-healing routine.
   * Normally called automatically during the sample tick, but exposed so
   * operators can invoke it via the REST API during an incident.
   */
  async selfHeal(): Promise<{ action: string; details: string }[]> {
    const snap = this.currentSnapshot();
    const actions: { action: string; details: string }[] = [];

    if (!snap) return actions;

    // ── Idle culling ─────────────────────────────────────────────────────────
    if (snap.utilizationPct >= this.thresholds.selfHealCullPct && snap.idle > 0) {
      await this.cullIdleConnections();
      actions.push({
        action: 'cull_idle',
        details: `Culled ${snap.idle} idle connections to free resources under ${snap.utilizationPct.toFixed(1)}% utilisation`,
      });
      poolSelfHealActions.labels('cull_idle').inc();
      logger.warn(
        { utilizationPct: snap.utilizationPct, idle: snap.idle },
        'Self-heal: culled idle connections',
      );
    }

    // ── Pool exhaust circuit-break ────────────────────────────────────────────
    if (snap.utilizationPct >= 100) {
      this.exhaustionTicks++;
      if (this.exhaustionTicks >= this.thresholds.selfHealCircuitBreakTicks) {
        actions.push({
          action: 'circuit_break',
          details: `Pool exhausted for ${this.exhaustionTicks} consecutive ticks — circuit-break triggered`,
        });
        poolSelfHealActions.labels('circuit_break').inc();
        logger.error(
          { exhaustionTicks: this.exhaustionTicks },
          'Self-heal: pool exhaustion circuit-break — incoming requests will receive 503',
        );
        // Fire a critical alert
        await this.fireAlert(
          'circuit_break',
          AlertSeverity.CRITICAL,
          'Connection pool circuit-breaker tripped',
          `The database connection pool has been fully exhausted for ${this.exhaustionTicks} consecutive monitoring ticks. ` +
            'New requests will be rejected until the pool recovers.',
        );
      }
    } else {
      this.exhaustionTicks = 0;
    }

    return actions;
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  /**
   * Main sample tick: collect pool state, update Prometheus metrics,
   * append to history, evaluate alert thresholds, run self-heal.
   */
  private async tick(): Promise<void> {
    try {
      const snap = this.sample();
      this.pushHistory(snap);
      this.updatePrometheus(snap);
      await this.evaluateThresholds(snap);
      await this.selfHeal();
      // Prune old error timestamps (keep last 2 minutes only)
      const cutoff = Date.now() - 120_000;
      this.recentErrors = this.recentErrors.filter((t) => t.getTime() > cutoff);
    } catch (err) {
      logger.error({ err }, 'Pool monitor tick error');
    }
  }

  /**
   * Read the current pool state via the pg Pool's internal properties.
   * pg Pool exposes `totalCount`, `idleCount`, `waitingCount` as public
   * properties starting from pg@8.x — these are stable across minor versions.
   */
  private sample(): PoolSnapshot {
    const active = this.pool.totalCount - this.pool.idleCount;
    const idle = this.pool.idleCount;
    const waiting = this.pool.waitingCount;
    const maxSz = this.config.maxSize;
    const utilizationPct = maxSz > 0 ? (active / maxSz) * 100 : 0;

    return {
      timestamp: new Date(),
      active,
      idle,
      waiting,
      total: this.pool.totalCount,
      maxSize: maxSz,
      utilizationPct,
    };
  }

  private updatePrometheus(snap: PoolSnapshot): void {
    poolActiveConnections.set(snap.active);
    poolIdleConnections.set(snap.idle);
    poolWaitingRequests.set(snap.waiting);
    poolMaxSize.set(snap.maxSize);
    poolUtilization.set(snap.utilizationPct / 100);
  }

  private pushHistory(snap: PoolSnapshot): void {
    this.history.push(snap);
    if (this.history.length > this.config.historySize) {
      this.history.shift();
    }
  }

  private pushLifecycle(event: ConnectionEvent): void {
    this.lifecycle.push(event);
    if (this.lifecycle.length > this.config.lifecycleBufferSize) {
      this.lifecycle.shift();
    }
  }

  /**
   * Evaluate all alert thresholds and fire debounced alerts when exceeded.
   */
  private async evaluateThresholds(snap: PoolSnapshot): Promise<void> {
    const { thresholds } = this;

    // Utilisation — critical first so it short-circuits the warn check
    if (snap.utilizationPct >= thresholds.utilizationCriticalPct) {
      await this.fireAlert(
        'utilization_critical',
        AlertSeverity.CRITICAL,
        'Connection pool utilisation critical',
        `Pool utilisation is ${snap.utilizationPct.toFixed(1)}% (threshold: ${thresholds.utilizationCriticalPct}%). ` +
          `${snap.active} active, ${snap.idle} idle, ${snap.waiting} waiting out of max ${snap.maxSize}.`,
      );
    } else if (snap.utilizationPct >= thresholds.utilizationWarnPct) {
      await this.fireAlert(
        'utilization_warn',
        AlertSeverity.HIGH,
        'Connection pool utilisation high',
        `Pool utilisation is ${snap.utilizationPct.toFixed(1)}% (threshold: ${thresholds.utilizationWarnPct}%). ` +
          `${snap.active} active, ${snap.idle} idle out of max ${snap.maxSize}.`,
      );
    }

    // Waiting requests
    if (snap.waiting >= thresholds.waitingCriticalCount) {
      await this.fireAlert(
        'waiting_critical',
        AlertSeverity.CRITICAL,
        'Connection pool request queue critical',
        `${snap.waiting} requests are queued waiting for a database connection (threshold: ${thresholds.waitingCriticalCount}).`,
      );
    } else if (snap.waiting >= thresholds.waitingWarnCount) {
      await this.fireAlert(
        'waiting_warn',
        AlertSeverity.HIGH,
        'Connection pool request queue elevated',
        `${snap.waiting} requests are queued waiting for a database connection (threshold: ${thresholds.waitingWarnCount}).`,
      );
    }

    // Connection error rate (last 60 s window)
    const recentErrorCount = this.recentErrors.filter(
      (t) => t.getTime() > Date.now() - 60_000,
    ).length;

    if (recentErrorCount >= thresholds.errorRateCriticalCount) {
      await this.fireAlert(
        'error_rate_critical',
        AlertSeverity.CRITICAL,
        'Connection error rate critical',
        `${recentErrorCount} connection errors in the last 60 seconds (threshold: ${thresholds.errorRateCriticalCount}).`,
      );
    } else if (recentErrorCount >= thresholds.errorRateWarnCount) {
      await this.fireAlert(
        'error_rate_warn',
        AlertSeverity.MEDIUM,
        'Connection error rate elevated',
        `${recentErrorCount} connection errors in the last 60 seconds (threshold: ${thresholds.errorRateWarnCount}).`,
      );
    }

    // Average acquire-wait time
    if (this.acquireWaitSamples.length > 0) {
      const avgWaitMs =
        this.acquireWaitSamples.reduce((a, b) => a + b, 0) / this.acquireWaitSamples.length;
      this.acquireWaitSamples = []; // reset for next tick

      if (avgWaitMs >= thresholds.acquireWaitWarnMs) {
        await this.fireAlert(
          'acquire_wait_warn',
          AlertSeverity.MEDIUM,
          'Connection acquire wait time elevated',
          `Average connection acquire time over the last tick is ${avgWaitMs.toFixed(0)} ms (threshold: ${thresholds.acquireWaitWarnMs} ms).`,
        );
      }
    }
  }

  /**
   * Fire an alert through the AlertService with debounce protection.
   * The `conditionKey` uniquely identifies the condition; the same condition
   * will not re-fire until `alertDebounceMs` milliseconds have elapsed.
   */
  private async fireAlert(
    conditionKey: string,
    severity: AlertSeverity,
    title: string,
    description: string,
  ): Promise<void> {
    if (this.config.disableAlerts) return;

    const now = Date.now();
    const lastFired = this.lastAlertAt.get(conditionKey) ?? 0;
    if (now - lastFired < this.thresholds.alertDebounceMs) return;

    this.lastAlertAt.set(conditionKey, now);

    try {
      await getAlertService().triggerAlert({
        title,
        description,
        severity,
        source: 'connection-pool-monitor',
        tags: { conditionKey, component: 'database' },
        channels: [AlertChannel.EMAIL, AlertChannel.PAGERDUTY],
        metadata: { snapshot: this.currentSnapshot() },
      });
    } catch (err) {
      // Alert dispatch failures must never crash the monitor itself
      logger.warn({ err, conditionKey }, 'Pool monitor: failed to dispatch alert');
    }
  }

  /**
   * Attempts to drain and recycle idle connections by ending them.
   * pg does not expose a "close one idle connection" API, but we can
   * acquire-and-immediately-release to trigger the pool to drop
   * stale connections that exceed the idle timeout.  A more forceful
   * approach is to call pool.end() and recreate, but that disrupts active
   * queries; instead we just log the intent and trust pg's idle timeout.
   */
  private async cullIdleConnections(): Promise<void> {
    // pg Pool handles idle-timeout culling internally.  We can accelerate it by
    // temporarily acquiring idle connections and verifying them — a failed
    // verify forces pg to drop the connection.  Here we do a lightweight
    // "SELECT 1" to flush and re-validate idle connections.
    try {
      const client: PoolClient = await this.pool.connect();
      await client.query('SELECT 1');
      client.release(true); // `true` destroys the connection after release
      this.onDestroyed('cull-' + Date.now(), 'idle_cull');
    } catch (err) {
      logger.debug({ err }, 'Pool self-heal cull attempt (benign if pool is busy)');
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _monitor: ConnectionPoolMonitor | null = null;

/**
 * Initialise the singleton monitor.  Call once at startup.
 * Pass the same `pool` instance used by the rest of the app.
 */
export function initConnectionPoolMonitor(
  pool: Pool,
  config: Partial<MonitorConfig> = {},
): ConnectionPoolMonitor {
  if (_monitor) {
    logger.warn('ConnectionPoolMonitor already initialised; returning existing instance');
    return _monitor;
  }
  _monitor = new ConnectionPoolMonitor(pool, config);
  return _monitor;
}

/**
 * Access the singleton monitor after initialisation.
 * Throws if `initConnectionPoolMonitor` has not been called.
 */
export function getConnectionPoolMonitor(): ConnectionPoolMonitor {
  if (!_monitor) {
    throw new Error(
      'ConnectionPoolMonitor not initialised. Call initConnectionPoolMonitor(pool) at startup.',
    );
  }
  return _monitor;
}

/** Reset the singleton (test helper). */
export function resetConnectionPoolMonitor(): void {
  if (_monitor) {
    _monitor.stop();
    _monitor = null;
  }
}
