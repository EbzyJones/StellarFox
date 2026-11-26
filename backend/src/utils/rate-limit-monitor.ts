/**
 * Rate Limit Monitoring and Management Utilities
 * 
 * Provides tools for:
 * - Real-time rate limit metrics
 * - Anomaly detection
 * - Quota management
 * - Rate limit analytics
 */

import type Redis from 'ioredis';
import { logger } from './logger';

export interface RateLimitMetrics {
  totalRequests: number;
  deniedRequests: number;
  denialRate: number; // 0-1
  topBlockedUsers: Array<{ key: string; deniedCount: number }>;
  topBlockedIps: Array<{ key: string; deniedCount: number }>;
  timestamp: Date;
}

export interface QuotaAllocation {
  key: string;
  initialTokens: number;
  tokensPerInterval: number;
  refillInterval: number;
  expiresAt: Date;
}

/**
 * Rate Limit Monitor for tracking and analyzing rate limiting behavior
 */
export class RateLimitMonitor {
  private redis: Redis;
  private metricsKeyPrefix: string;
  private updateInterval: ReturnType<typeof setInterval> | null = null;

  constructor(redis: Redis, metricsKeyPrefix: string = 'rate-limit-metrics') {
    this.redis = redis;
    this.metricsKeyPrefix = metricsKeyPrefix;
  }

  /**
   * Records a successful request
   */
  async recordSuccess(key: string, endpoint: string): Promise<void> {
    try {
      const now = new Date();
      const dateKey = now.toISOString().split('T')[0];
      const hourKey = `${dateKey}-${now.getHours()}`;

      await Promise.all([
        // Global metrics
        this.redis.incr(`${this.metricsKeyPrefix}:total:${dateKey}`),
        this.redis.incr(`${this.metricsKeyPrefix}:success:${dateKey}`),

        // Hour-level aggregation
        this.redis.incr(`${this.metricsKeyPrefix}:success:hour:${hourKey}`),
        this.redis.incr(`${this.metricsKeyPrefix}:total:hour:${hourKey}`),

        // Endpoint-level tracking
        this.redis.incr(`${this.metricsKeyPrefix}:endpoint:${endpoint}:${dateKey}`),

        // Per-key tracking
        this.redis.incr(`${this.metricsKeyPrefix}:key:${key}:success:${dateKey}`),

        // Set expiration for cleanup
        this.redis.expire(`${this.metricsKeyPrefix}:total:${dateKey}`, 86400 * 7), // 7 days
      ]);
    } catch (err) {
      logger.error({ err, key, endpoint }, 'Failed to record success metric');
    }
  }

  /**
   * Records a denied request (rate limit exceeded)
   */
  async recordDenial(key: string, endpoint: string, retryAfter: number): Promise<void> {
    try {
      const now = new Date();
      const dateKey = now.toISOString().split('T')[0];
      const hourKey = `${dateKey}-${now.getHours()}`;

      await Promise.all([
        // Global metrics
        this.redis.incr(`${this.metricsKeyPrefix}:total:${dateKey}`),
        this.redis.incr(`${this.metricsKeyPrefix}:denied:${dateKey}`),

        // Hour-level aggregation
        this.redis.incr(`${this.metricsKeyPrefix}:denied:hour:${hourKey}`),
        this.redis.incr(`${this.metricsKeyPrefix}:total:hour:${hourKey}`),

        // Endpoint-level tracking
        this.redis.incr(`${this.metricsKeyPrefix}:endpoint:${endpoint}:denied:${dateKey}`),

        // Per-key tracking
        this.redis.incr(`${this.metricsKeyPrefix}:key:${key}:denied:${dateKey}`),

        // Track retry-after values for optimization
        this.redis.zadd(
          `${this.metricsKeyPrefix}:retry-after:${dateKey}`,
          Date.now() + retryAfter * 1000,
          `${key}:${endpoint}`,
        ),

        // Set expiration
        this.redis.expire(`${this.metricsKeyPrefix}:denied:${dateKey}`, 86400 * 7),
      ]);

      // Check for anomalies
      await this.checkDenialAnomaly(key, endpoint);
    } catch (err) {
      logger.error({ err, key, endpoint }, 'Failed to record denial metric');
    }
  }

  /**
   * Gets current metrics for a time period
   */
  async getMetrics(dateStr?: string): Promise<RateLimitMetrics> {
    try {
      const date = dateStr ? new Date(dateStr) : new Date();
      const dateKey = date.toISOString().split('T')[0];

      const [total, denied] = await Promise.all([
        this.redis.get(`${this.metricsKeyPrefix}:total:${dateKey}`),
        this.redis.get(`${this.metricsKeyPrefix}:denied:${dateKey}`),
      ]);

      const totalRequests = parseInt(total ?? '0', 10);
      const deniedRequests = parseInt(denied ?? '0', 10);
      const denialRate = totalRequests > 0 ? deniedRequests / totalRequests : 0;

      return {
        totalRequests,
        deniedRequests,
        denialRate,
        topBlockedUsers: await this.getTopDeniedKeys('user', 10),
        topBlockedIps: await this.getTopDeniedKeys('ip', 10),
        timestamp: new Date(),
      };
    } catch (err) {
      logger.error({ err }, 'Failed to get rate limit metrics');
      return {
        totalRequests: 0,
        deniedRequests: 0,
        denialRate: 0,
        topBlockedUsers: [],
        topBlockedIps: [],
        timestamp: new Date(),
      };
    }
  }

  /**
   * Gets top denied keys for a specific type
   */
  private async getTopDeniedKeys(
    type: 'user' | 'ip',
    limit: number = 10,
  ): Promise<Array<{ key: string; deniedCount: number }>> {
    try {
      const dateKey = new Date().toISOString().split('T')[0];
      const pattern = `${this.metricsKeyPrefix}:key:*:denied:${dateKey}`;

      const keys = await this.redis.keys(pattern);
      const counts: Array<{ key: string; count: number }> = [];

      for (const key of keys) {
        const count = parseInt((await this.redis.get(key)) ?? '0', 10);
        counts.push({
          key: key.replace(`${this.metricsKeyPrefix}:key:`, '').replace(`:denied:${dateKey}`, ''),
          count,
        });
      }

      return counts
        .sort((a, b) => b.count - a.count)
        .slice(0, limit)
        .map((item) => ({
          key: item.key,
          deniedCount: item.count,
        }));
    } catch (err) {
      logger.error({ err }, 'Failed to get top denied keys');
      return [];
    }
  }

  /**
   * Checks for denial anomalies (potential abuse or DDoS)
   */
  private async checkDenialAnomaly(key: string, endpoint: string): Promise<void> {
    try {
      const dateKey = new Date().toISOString().split('T')[0];
      const denialKey = `${this.metricsKeyPrefix}:key:${key}:denied:${dateKey}`;
      const denialCount = parseInt((await this.redis.get(denialKey)) ?? '0', 10);

      // Alert if a single key gets more than 100 denials in a day
      if (denialCount > 100) {
        logger.warn(
          {
            key,
            endpoint,
            denialCount,
          },
          'Rate limit denial anomaly detected',
        );

        // Optionally store for analysis
        await this.redis.zadd(
          `${this.metricsKeyPrefix}:anomalies:${dateKey}`,
          denialCount,
          key,
        );
      }
    } catch (err) {
      logger.error({ err }, 'Failed to check denial anomaly');
    }
  }

  /**
   * Gets endpoint-specific statistics
   */
  async getEndpointStats(endpoint: string): Promise<{
    totalRequests: number;
    deniedRequests: number;
    denialRate: number;
  }> {
    try {
      const dateKey = new Date().toISOString().split('T')[0];
      const totalKey = `${this.metricsKeyPrefix}:endpoint:${endpoint}:${dateKey}`;
      const deniedKey = `${this.metricsKeyPrefix}:endpoint:${endpoint}:denied:${dateKey}`;

      const [total, denied] = await Promise.all([
        this.redis.get(totalKey),
        this.redis.get(deniedKey),
      ]);

      const totalRequests = parseInt(total ?? '0', 10);
      const deniedRequests = parseInt(denied ?? '0', 10);

      return {
        totalRequests,
        deniedRequests,
        denialRate: totalRequests > 0 ? deniedRequests / totalRequests : 0,
      };
    } catch (err) {
      logger.error({ err, endpoint }, 'Failed to get endpoint stats');
      return {
        totalRequests: 0,
        deniedRequests: 0,
        denialRate: 0,
      };
    }
  }

  /**
   * Lists all anomalies detected in a time period
   */
  async listAnomalies(dateStr?: string): Promise<Array<{ key: string; denials: number }>> {
    try {
      const date = dateStr ? new Date(dateStr) : new Date();
      const dateKey = date.toISOString().split('T')[0];
      const anomalyKey = `${this.metricsKeyPrefix}:anomalies:${dateKey}`;

      const result = await this.redis.zrevrange(anomalyKey, 0, -1, 'WITHSCORES');
      const anomalies = [];

      for (let i = 0; i < result.length; i += 2) {
        anomalies.push({
          key: result[i],
          denials: parseInt(result[i + 1], 10),
        });
      }

      return anomalies;
    } catch (err) {
      logger.error({ err }, 'Failed to list anomalies');
      return [];
    }
  }

  /**
   * Cleans up old metrics data
   */
  async cleanupOldMetrics(daysToKeep: number = 7): Promise<number> {
    try {
      let deleted = 0;

      for (let i = daysToKeep; i < daysToKeep + 30; i++) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateKey = date.toISOString().split('T')[0];

        const pattern = `${this.metricsKeyPrefix}:*:${dateKey}`;
        const keys = await this.redis.keys(pattern);

        if (keys.length > 0) {
          deleted += await this.redis.del(...keys);
        }
      }

      logger.info({ deleted }, 'Cleaned up old rate limit metrics');
      return deleted;
    } catch (err) {
      logger.error({ err }, 'Failed to cleanup old metrics');
      return 0;
    }
  }

  /**
   * Starts periodic cleanup of old metrics
   */
  startPeriodicCleanup(intervalMs: number = 86400000): void {
    // Default: once per day
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }

    this.updateInterval = setInterval(async () => {
      await this.cleanupOldMetrics(7);
    }, intervalMs);

    logger.info('Rate limit metrics cleanup scheduled');
  }

  /**
   * Stops periodic cleanup
   */
  stopPeriodicCleanup(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }
}

/**
 * Quota Manager for handling temporary quota increases or reservations
 */
export class RateLimitQuotaManager {
  private redis: Redis;
  private quotaKeyPrefix: string;

  constructor(redis: Redis, quotaKeyPrefix: string = 'rate-limit-quota') {
    this.redis = redis;
    this.quotaKeyPrefix = quotaKeyPrefix;
  }

  /**
   * Allocates temporary quota increase for a key
   */
  async allocateQuota(
    key: string,
    tokensToAdd: number,
    durationMs: number,
  ): Promise<boolean> {
    try {
      const quotaKey = `${this.quotaKeyPrefix}:${key}`;
      const result = await this.redis.set(
        quotaKey,
        tokensToAdd,
        'PX',
        durationMs,
        'NX',
      );

      if (result === 'OK') {
        logger.info(
          { key, tokensToAdd, durationMs },
          'Quota allocated',
        );
        return true;
      }

      return false;
    } catch (err) {
      logger.error({ err, key }, 'Failed to allocate quota');
      return false;
    }
  }

  /**
   * Gets remaining quota for a key
   */
  async getQuota(key: string): Promise<number | null> {
    try {
      const quotaKey = `${this.quotaKeyPrefix}:${key}`;
      const quota = await this.redis.get(quotaKey);
      return quota ? parseInt(quota, 10) : null;
    } catch (err) {
      logger.error({ err, key }, 'Failed to get quota');
      return null;
    }
  }

  /**
   * Revokes allocated quota
   */
  async revokeQuota(key: string): Promise<void> {
    try {
      const quotaKey = `${this.quotaKeyPrefix}:${key}`;
      await this.redis.del(quotaKey);
      logger.info({ key }, 'Quota revoked');
    } catch (err) {
      logger.error({ err, key }, 'Failed to revoke quota');
    }
  }
}
