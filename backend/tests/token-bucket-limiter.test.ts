/**
 * Token Bucket Limiter Tests
 * 
 * Integration tests for the token bucket rate limiting system
 */

import Redis from 'ioredis';
import { TokenBucketLimiter, tokenBucketPresets } from '../src/services/token-bucket-limiter';
import { RateLimitMonitor, RateLimitQuotaManager } from '../src/utils/rate-limit-monitor';

describe('TokenBucketLimiter', () => {
  let redis: Redis;
  let limiter: TokenBucketLimiter;

  beforeAll(() => {
    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      retryStrategy: () => null,
    });
  });

  afterAll(async () => {
    await redis.flushdb();
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.flushdb();
    limiter = new TokenBucketLimiter(redis, tokenBucketPresets.standard());
  });

  describe('consume', () => {
    it('should allow requests when tokens are available', async () => {
      const result = await limiter.consume('test-key', 1);

      expect(result.allowed).toBe(true);
      expect(result.tokensRemaining).toBeLessThanOrEqual(result.tokensNeeded + 1);
    });

    it('should track remaining tokens correctly', async () => {
      const capacity = tokenBucketPresets.standard().capacity;

      // Consume 5 tokens
      for (let i = 0; i < 5; i++) {
        const result = await limiter.consume('test-key', 1);
        expect(result.allowed).toBe(true);
      }

      // 6th request should still be allowed (capacity is 20)
      const result = await limiter.consume('test-key', 1);
      expect(result.allowed).toBe(true);
      expect(result.tokensRemaining).toBeLessThanOrEqual(capacity - 6);
    });

    it('should deny requests when capacity is exceeded', async () => {
      const config = tokenBucketPresets.sensitive();

      const sensitiveLimiter = new TokenBucketLimiter(redis, config);

      // Consume all tokens in burst capacity (2)
      for (let i = 0; i < config.capacity; i++) {
        const result = await sensitiveLimiter.consume('test-key-2', 1);
        expect(result.allowed).toBe(true);
      }

      // Next request should be denied
      const result = await sensitiveLimiter.consume('test-key-2', 1);
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should handle multiple tokens consumption', async () => {
      const result = await limiter.consume('test-key-multi', 5);

      expect(result.allowed).toBe(true);
      expect(result.tokensRemaining).toBeGreaterThanOrEqual(0);
    });

    it('should reject requests exceeding capacity', async () => {
      const config = tokenBucketPresets.standard();
      
      expect(() => {
        limiter.consume('test-key', config.capacity + 1);
      }).rejects.toThrow();
    });

    it('should refill tokens after refill interval', async () => {
      const config = {
        capacity: 2,
        tokensPerInterval: 1,
        refillInterval: 100, // 100ms
      };

      const quickLimiter = new TokenBucketLimiter(redis, config);

      // Consume both tokens
      await quickLimiter.consume('refill-test', 1);
      await quickLimiter.consume('refill-test', 1);

      // Should be denied
      let result = await quickLimiter.consume('refill-test', 1);
      expect(result.allowed).toBe(false);

      // Wait for refill
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should be allowed now
      result = await quickLimiter.consume('refill-test', 1);
      expect(result.allowed).toBe(true);
    });

    it('should use different buckets for different keys', async () => {
      const result1 = await limiter.consume('key-1', 1);
      const result2 = await limiter.consume('key-2', 1);

      expect(result1.allowed).toBe(true);
      expect(result2.allowed).toBe(true);
      // Both should have different token counts
      expect(result1.tokensRemaining).not.toBe(result2.tokensRemaining);
    });
  });

  describe('reset', () => {
    it('should reset bucket to full capacity', async () => {
      // Consume tokens
      await limiter.consume('reset-test', 10);

      // Check state before reset
      let state = await limiter.getState('reset-test');
      expect(state.tokensAvailable).toBeLessThan(state.capacity);

      // Reset
      await limiter.reset('reset-test');

      // Check state after reset
      state = await limiter.getState('reset-test');
      expect(state.tokensAvailable).toBe(state.capacity);
    });
  });

  describe('getState', () => {
    it('should return full capacity for new key', async () => {
      const state = await limiter.getState('new-key');

      expect(state.tokensAvailable).toBe(state.capacity);
      expect(state.isEmpty).toBe(false);
    });

    it('should track token consumption', async () => {
      await limiter.consume('state-test', 5);

      const state = await limiter.getState('state-test');

      expect(state.tokensAvailable).toBeLessThan(state.capacity);
      expect(state.isEmpty).toBe(false);
    });

    it('should report empty state when all tokens consumed', async () => {
      const config = tokenBucketPresets.sensitive();
      const sensitiveLimiter = new TokenBucketLimiter(redis, config);

      // Consume all tokens
      for (let i = 0; i < config.capacity; i++) {
        await sensitiveLimiter.consume('empty-test', 1);
      }

      const state = await sensitiveLimiter.getState('empty-test');

      expect(state.isEmpty).toBe(true);
      expect(state.tokensAvailable).toBe(0);
    });
  });

  describe('addTokens', () => {
    it('should add tokens to bucket', async () => {
      // Consume some tokens
      await limiter.consume('add-test', 10);

      const stateBefore = await limiter.getState('add-test');

      // Add tokens
      const added = await limiter.addTokens('add-test', 5);

      expect(added).toBeGreaterThan(0);

      const stateAfter = await limiter.getState('add-test');

      expect(stateAfter.tokensAvailable).toBeGreaterThan(stateBefore.tokensAvailable);
    });

    it('should not exceed capacity when adding tokens', async () => {
      const added = await limiter.addTokens('overflow-test', 1000);

      const state = await limiter.getState('overflow-test');

      expect(state.tokensAvailable).toBe(state.capacity);
      expect(added).toBeLessThanOrEqual(state.capacity);
    });
  });

  describe('clearBucketsWithPattern', () => {
    it('should clear buckets matching pattern', async () => {
      // Create multiple buckets
      await limiter.consume('user:123:endpoint1', 1);
      await limiter.consume('user:123:endpoint2', 1);
      await limiter.consume('user:456:endpoint1', 1);

      // Clear pattern
      const deleted = await limiter.clearBucketsWithPattern('user:123:*');

      expect(deleted).toBeGreaterThanOrEqual(2);
    });
  });

  describe('presets', () => {
    it('should have sensitive preset with appropriate limits', () => {
      const config = tokenBucketPresets.sensitive();

      expect(config.capacity).toBe(2);
      expect(config.tokensPerInterval).toBe(5);
      expect(config.refillInterval).toBe(60000);
    });

    it('should have standard preset with higher limits', () => {
      const config = tokenBucketPresets.standard();

      expect(config.capacity).toBe(20);
      expect(config.tokensPerInterval).toBe(100);
      expect(config.refillInterval).toBe(60000);
    });

    it('should have generous preset for public endpoints', () => {
      const config = tokenBucketPresets.generous();

      expect(config.capacity).toBe(200);
      expect(config.tokensPerInterval).toBe(1000);
      expect(config.refillInterval).toBe(60000);
    });

    it('should create custom presets', () => {
      const config = tokenBucketPresets.custom(50, 500, 30000);

      expect(config.capacity).toBe(50);
      expect(config.tokensPerInterval).toBe(500);
      expect(config.refillInterval).toBe(30000);
    });
  });

  describe('error handling', () => {
    it('should validate capacity on construction', () => {
      expect(() => {
        new TokenBucketLimiter(redis, {
          capacity: -1,
          tokensPerInterval: 10,
          refillInterval: 60000,
        });
      }).toThrow();
    });

    it('should validate tokensPerInterval', () => {
      expect(() => {
        new TokenBucketLimiter(redis, {
          capacity: 10,
          tokensPerInterval: -1,
          refillInterval: 60000,
        });
      }).toThrow();
    });

    it('should validate refillInterval', () => {
      expect(() => {
        new TokenBucketLimiter(redis, {
          capacity: 10,
          tokensPerInterval: 10,
          refillInterval: -1,
        });
      }).toThrow();
    });
  });
});

describe('RateLimitMonitor', () => {
  let redis: Redis;
  let monitor: RateLimitMonitor;

  beforeAll(() => {
    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      retryStrategy: () => null,
    });
  });

  afterAll(async () => {
    await redis.flushdb();
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.flushdb();
    monitor = new RateLimitMonitor(redis);
  });

  describe('recordSuccess', () => {
    it('should record successful requests', async () => {
      await monitor.recordSuccess('user:123', '/api/users');

      const metrics = await monitor.getMetrics();

      expect(metrics.totalRequests).toBeGreaterThan(0);
    });
  });

  describe('recordDenial', () => {
    it('should record denied requests', async () => {
      await monitor.recordDenial('user:123', '/api/users', 30);

      const metrics = await monitor.getMetrics();

      expect(metrics.deniedRequests).toBeGreaterThan(0);
    });
  });

  describe('getMetrics', () => {
    it('should calculate denial rate correctly', async () => {
      // Record 7 successes and 3 denials = 30% denial rate
      for (let i = 0; i < 7; i++) {
        await monitor.recordSuccess(`user:${i}`, '/api/test');
      }

      for (let i = 0; i < 3; i++) {
        await monitor.recordDenial(`user:${i}`, '/api/test', 30);
      }

      const metrics = await monitor.getMetrics();

      expect(metrics.totalRequests).toBe(10);
      expect(metrics.deniedRequests).toBe(3);
      expect(metrics.denialRate).toBeCloseTo(0.3, 1);
    });
  });
});

describe('RateLimitQuotaManager', () => {
  let redis: Redis;
  let quotaManager: RateLimitQuotaManager;

  beforeAll(() => {
    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      retryStrategy: () => null,
    });
  });

  afterAll(async () => {
    await redis.flushdb();
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.flushdb();
    quotaManager = new RateLimitQuotaManager(redis);
  });

  describe('allocateQuota', () => {
    it('should allocate quota for a key', async () => {
      const result = await quotaManager.allocateQuota('user:123', 100, 3600000);

      expect(result).toBe(true);
    });

    it('should not allow duplicate quota', async () => {
      await quotaManager.allocateQuota('user:456', 100, 3600000);
      const result = await quotaManager.allocateQuota('user:456', 100, 3600000);

      expect(result).toBe(false);
    });
  });

  describe('getQuota', () => {
    it('should retrieve allocated quota', async () => {
      await quotaManager.allocateQuota('user:789', 100, 3600000);
      const quota = await quotaManager.getQuota('user:789');

      expect(quota).toBe(100);
    });

    it('should return null for non-existent quota', async () => {
      const quota = await quotaManager.getQuota('nonexistent');

      expect(quota).toBeNull();
    });
  });

  describe('revokeQuota', () => {
    it('should revoke allocated quota', async () => {
      await quotaManager.allocateQuota('user:111', 100, 3600000);
      await quotaManager.revokeQuota('user:111');

      const quota = await quotaManager.getQuota('user:111');

      expect(quota).toBeNull();
    });
  });
});
