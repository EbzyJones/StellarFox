/**
 * Dynamic Connection Pool Management Service
 *
 * Wraps the shared pg Pool with:
 *   – Adaptive pool-size recommendations based on real-time load patterns.
 *   – Per-connection lifecycle hooks that feed the ConnectionPoolMonitor.
 *   – A monitored `connect()` helper that records wait time and hold time.
 *
 * Most metric collection and self-healing logic lives in
 * connectionPoolMonitor.service.ts; this module bridges the pool usage layer
 * to that monitor.
 */

import { Pool, PoolClient } from 'pg';
import { logger } from '../utils/logger';
import {
  getConnectionPoolMonitor,
  ConnectionPoolMonitor,
} from './connectionPoolMonitor.service';

export interface PoolConfig {
  max: number;
  min: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  maxQueryTimeMs: number;
  statementTimeoutMs: number;
}

export interface PoolMetrics {
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
  waitingRequests: number;
  connectionUtilization: number;
  avgQueryTime: number;
  connectionErrors: number;
  lastUpdated: Date;
}

export interface LoadPattern {
  timestamp: Date;
  requestRate: number;
  avgConnectionDuration: number;
  connectionErrorRate: number;
  cpuUsage: number;
  memoryUsage: number;
}

// ── Monitored connect helper ──────────────────────────────────────────────────

let _connectionSeq = 0;

function nextConnectionId(): string {
  return `conn-${process.pid}-${++_connectionSeq}`;
}

/**
 * Acquire a client from the pool, recording wait time and hold time via the
 * ConnectionPoolMonitor.  Returns the client and a `release` function.
 *
 * Usage:
 *   const { client, release } = await acquireMonitoredConnection(pool);
 *   try {
 *     await client.query('...');
 *   } finally {
 *     release();
 *   }
 */
export async function acquireMonitoredConnection(pool: Pool): Promise<{
  client: PoolClient;
  release: (err?: Error) => void;
}> {
  let monitor: ConnectionPoolMonitor | undefined;
  try {
    monitor = getConnectionPoolMonitor();
  } catch {
    // Monitor not initialised — proceed without tracking
  }

  const id = nextConnectionId();
  monitor?.onWaitStart(id);

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    monitor?.onError(id, reason.slice(0, 100));
    throw err;
  }

  monitor?.onAcquired(id);

  const release = (err?: Error): void => {
    if (err) {
      monitor?.onDestroyed(id, err.message.slice(0, 100));
      client.release(err);
    } else {
      monitor?.onReleased(id);
      client.release();
    }
  };

  return { client, release };
}

// ── DynamicPoolManager ────────────────────────────────────────────────────────

/**
 * Tracks load patterns and derives pool-size recommendations.
 * Does NOT recreate the Pool object (pg does not support dynamic resizing).
 * Instead it logs recommendations and exposes them via the REST API so an
 * operator (or future automation) can apply them to the pool config.
 */
export class DynamicPoolManager {
  private readonly pool: Pool;
  private currentConfig: PoolConfig;
  private loadPatterns: LoadPattern[] = [];
  private queryStats = new Map<string, { count: number; totalTime: number }>();
  private metricsInterval: NodeJS.Timeout | null = null;
  private readonly maxPoolSize = 100;
  private readonly minPoolSize = 5;

  constructor(pool: Pool, initialConfig: PoolConfig) {
    this.pool = pool;
    this.currentConfig = initialConfig;
  }

  /** Start periodic load-pattern recording. */
  startMonitoring(intervalMs = 30_000): void {
    if (this.metricsInterval) return;
    this.metricsInterval = setInterval(async () => {
      try {
        this.recordLoadPattern();
        this.logRecommendations();
      } catch (err) {
        logger.error({ err }, 'DynamicPoolManager monitoring tick error');
      }
    }, intervalMs);
    logger.info('DynamicPoolManager load-pattern monitoring started');
  }

  stopMonitoring(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = null;
    }
  }

  trackQueryExecution(query: string, durationMs: number): void {
    const key = this.normalizeQuery(query);
    const existing = this.queryStats.get(key) ?? { count: 0, totalTime: 0 };
    existing.count++;
    existing.totalTime += durationMs;
    this.queryStats.set(key, existing);
  }

  recordConnectionError(): void {
    try {
      getConnectionPoolMonitor().onError('legacy', 'recorded_via_service');
    } catch {
      // Monitor not initialised; ignore
    }
  }

  getMetrics(): PoolMetrics {
    const active = this.pool.totalCount - this.pool.idleCount;
    return {
      totalConnections: this.pool.totalCount,
      activeConnections: active,
      idleConnections: this.pool.idleCount,
      waitingRequests: this.pool.waitingCount,
      connectionUtilization: this.currentConfig.max > 0
        ? (active / this.currentConfig.max) * 100
        : 0,
      avgQueryTime: this.computeAvgQueryTime(),
      connectionErrors: 0,
      lastUpdated: new Date(),
    };
  }

  getConfiguration(): PoolConfig {
    return { ...this.currentConfig };
  }

  getLoadPatterns(): LoadPattern[] {
    return [...this.loadPatterns];
  }

  getHealthStatus(): { healthy: boolean; issues: string[] } {
    try {
      const summary = getConnectionPoolMonitor().healthSummary();
      return { healthy: summary.status === 'healthy', issues: summary.issues };
    } catch {
      // Fall back to basic check
      const metrics = this.getMetrics();
      const issues: string[] = [];
      if (metrics.connectionUtilization > 95) issues.push('Pool nearly exhausted');
      if (metrics.waitingRequests > 10) issues.push('High waiting requests');
      return { healthy: issues.length === 0, issues };
    }
  }

  generatePerformanceReport(): {
    currentMetrics: PoolMetrics;
    configuration: PoolConfig;
    healthStatus: { healthy: boolean; issues: string[] };
    recommendations: string[];
  } {
    const recommendations: string[] = [];
    const metrics = this.getMetrics();

    if (metrics.connectionUtilization > 80) {
      recommendations.push(
        `Increase DB_POOL_MAX beyond current ${this.currentConfig.max}`,
      );
    }
    if (metrics.avgQueryTime > 2000) {
      recommendations.push('Review slow queries and add missing indexes');
    }

    const recent = this.loadPatterns[this.loadPatterns.length - 1];
    if (recent) {
      if (recent.cpuUsage > 80) recommendations.push('High CPU — consider horizontal scaling');
      if (recent.memoryUsage > 80) recommendations.push('High memory — review query result sizes');
    }

    return {
      currentMetrics: metrics,
      configuration: this.getConfiguration(),
      healthStatus: this.getHealthStatus(),
      recommendations,
    };
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private recordLoadPattern(): void {
    let totalQueryTime = 0;
    let totalQueries = 0;
    this.queryStats.forEach(({ count, totalTime }) => {
      totalQueries += count;
      totalQueryTime += totalTime;
    });

    const pattern: LoadPattern = {
      timestamp: new Date(),
      requestRate: totalQueries / 30,
      avgConnectionDuration: totalQueries > 0 ? totalQueryTime / totalQueries : 0,
      connectionErrorRate: 0,
      cpuUsage: this.getCPUUsage(),
      memoryUsage: this.getMemoryUsage(),
    };

    this.loadPatterns.push(pattern);
    if (this.loadPatterns.length > 100) this.loadPatterns.shift();
  }

  private logRecommendations(): void {
    const metrics = this.getMetrics();
    if (metrics.connectionUtilization > 80 && this.currentConfig.max < this.maxPoolSize) {
      const recommended = Math.min(
        Math.ceil(this.currentConfig.max * 1.2),
        this.maxPoolSize,
      );
      logger.info(
        { current: this.currentConfig.max, recommended },
        'DynamicPoolManager: recommend increasing DB_POOL_MAX',
      );
    }
    if (metrics.connectionUtilization < 30 && this.currentConfig.max > this.minPoolSize) {
      const recommended = Math.max(
        Math.floor(this.currentConfig.max * 0.9),
        this.minPoolSize,
      );
      logger.info(
        { current: this.currentConfig.max, recommended },
        'DynamicPoolManager: recommend decreasing DB_POOL_MAX',
      );
    }
  }

  private computeAvgQueryTime(): number {
    let total = 0;
    let count = 0;
    this.queryStats.forEach(({ count: c, totalTime }) => {
      count += c;
      total += totalTime;
    });
    return count > 0 ? total / count : 0;
  }

  private normalizeQuery(query: string): string {
    return query
      .replace(/\$\d+/g, '$X')
      .replace(/'[^']*'/g, "'?'")
      .replace(/\d+/g, 'N');
  }

  private getCPUUsage(): number {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const os = require('os') as typeof import('os');
      const cpus = os.cpus();
      let idle = 0;
      let total = 0;
      for (const cpu of cpus) {
        for (const type of Object.keys(cpu.times) as (keyof typeof cpu.times)[]) {
          total += cpu.times[type];
        }
        idle += cpu.times.idle;
      }
      return total > 0 ? Math.round(((total - idle) / total) * 100) : 0;
    } catch {
      return 0;
    }
  }

  private getMemoryUsage(): number {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const os = require('os') as typeof import('os');
      return Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 100);
    } catch {
      return 0;
    }
  }
}

// ── Singleton factory ─────────────────────────────────────────────────────────

let _manager: DynamicPoolManager | null = null;

export function createDynamicPoolManager(pool: Pool, config: PoolConfig): DynamicPoolManager {
  return new DynamicPoolManager(pool, config);
}

export function initializeDynamicPoolManager(pool: Pool, config: PoolConfig): DynamicPoolManager {
  _manager = createDynamicPoolManager(pool, config);
  _manager.startMonitoring(30_000);
  return _manager;
}

export function getDynamicPoolManager(): DynamicPoolManager | null {
  return _manager;
}
