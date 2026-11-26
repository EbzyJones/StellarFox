import type Redis from 'ioredis';
import { logger } from '../utils/logger';

/**
 * Token Bucket Rate Limiting
 * 
 * Implements the token bucket algorithm for sophisticated rate limiting with:
 * - Per-endpoint granular control
 * - Configurable burst allowances
 * - Variable recovery rates
 * - Smooth traffic distribution
 * - Distributed synchronization across multiple backend instances via Redis
 */

export interface TokenBucketConfig {
  /** Maximum tokens in the bucket (burst allowance) */
  capacity: number;
  /** Number of tokens added per refill interval */
  tokensPerInterval: number;
  /** Interval in milliseconds for token refill */
  refillInterval: number;
  /** Key prefix for Redis storage */
  keyPrefix?: string;
}

export interface TokenBucketResult {
  allowed: boolean;
  tokensRemaining: number;
  tokensNeeded: number;
  resetAt: number;
  retryAfter: number;
}

/**
 * Lua script for atomic token bucket operations in Redis
 * Ensures consistency across distributed instances
 */
const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local tokens_per_interval = tonumber(ARGV[3])
local refill_interval = tonumber(ARGV[4])
local tokens_requested = tonumber(ARGV[5])

-- Get current bucket state: [last_refill_time, tokens]
local bucket = redis.call('HMGET', key, 'last_refill', 'tokens')
local last_refill = tonumber(bucket[1]) or now
local tokens = tonumber(bucket[2]) or capacity

-- Calculate elapsed time and refill tokens
local elapsed = now - last_refill
local refills = math.floor(elapsed / refill_interval)
if refills > 0 then
  tokens = math.min(capacity, tokens + (refills * tokens_per_interval))
  last_refill = last_refill + (refills * refill_interval)
end

-- Check if request can be satisfied
local allowed = 0
if tokens >= tokens_requested then
  allowed = 1
  tokens = tokens - tokens_requested
end

-- Store updated bucket state with expiration
redis.call('HSET', key, 'last_refill', last_refill, 'tokens', tokens)
redis.call('EXPIRE', key, math.ceil(refill_interval / 1000) + 3600)

-- Calculate reset time (when bucket will be full again)
local tokens_needed = capacity - tokens
local refills_needed = math.ceil(tokens_needed / tokens_per_interval)
local reset_at = last_refill + (refills_needed * refill_interval)

-- Calculate time until next token available if request denied
local retry_after = 0
if allowed == 0 then
  retry_after = math.ceil((tokens_requested - tokens) / tokens_per_interval * refill_interval)
  retry_after = math.max(1, retry_after)
end

return {allowed, tokens, tokens_requested, reset_at, retry_after}
`;

/**
 * TokenBucketLimiter manages rate limiting using the token bucket algorithm
 * with Redis backend for distributed consistency
 */
export class TokenBucketLimiter {
  private redis: Redis;
  private config: TokenBucketConfig;
  private keyPrefix: string;

  constructor(redis: Redis, config: TokenBucketConfig) {
    this.redis = redis;
    this.config = config;
    this.keyPrefix = config.keyPrefix ?? 'token-bucket';

    this.validateConfig();
  }

  /**
   * Validates the token bucket configuration
   */
  private validateConfig(): void {
    if (this.config.capacity <= 0) {
      throw new RangeError('Capacity must be greater than 0');
    }
    if (this.config.tokensPerInterval <= 0) {
      throw new RangeError('tokensPerInterval must be greater than 0');
    }
    if (this.config.refillInterval <= 0) {
      throw new RangeError('refillInterval must be greater than 0');
    }
    if (this.config.tokensPerInterval > this.config.capacity) {
      logger.warn(
        {
          tokensPerInterval: this.config.tokensPerInterval,
          capacity: this.config.capacity,
        },
        'tokensPerInterval exceeds capacity; bucket will overflow on refill',
      );
    }
  }

  /**
   * Attempts to consume tokens from the bucket
   * @param key Unique identifier for the bucket (e.g., user ID, IP address)
   * @param tokensRequested Number of tokens to consume (default: 1)
   * @returns TokenBucketResult with consumption result and metadata
   */
  async consume(key: string, tokensRequested: number = 1): Promise<TokenBucketResult> {
    if (!Number.isInteger(tokensRequested) || tokensRequested <= 0) {
      throw new RangeError('tokensRequested must be a positive integer');
    }

    if (tokensRequested > this.config.capacity) {
      throw new RangeError(
        `tokensRequested (${tokensRequested}) cannot exceed capacity (${this.config.capacity})`,
      );
    }

    try {
      const redisKey = `${this.keyPrefix}:${key}`;
      const now = Date.now();

      const result = await this.redis.eval(
        TOKEN_BUCKET_SCRIPT,
        1,
        redisKey,
        now,
        this.config.capacity,
        this.config.tokensPerInterval,
        this.config.refillInterval,
        tokensRequested,
      );

      if (!Array.isArray(result) || result.length !== 5) {
        throw new Error('Invalid token bucket result from Redis');
      }

      const [allowed, tokensRemaining, tokensNeeded, resetAt, retryAfter] = result.map(Number);

      if (!Number.isFinite(tokensRemaining) || !Number.isFinite(resetAt)) {
        throw new Error('Invalid numeric values from Redis script');
      }

      return {
        allowed: allowed === 1,
        tokensRemaining: Math.max(0, tokensRemaining),
        tokensNeeded,
        resetAt,
        retryAfter: Math.max(0, retryAfter),
      };
    } catch (err) {
      logger.error(
        {
          err,
          key,
          tokensRequested,
          config: this.config,
        },
        'Token bucket consumption failed',
      );
      throw err;
    }
  }

  /**
   * Resets the bucket to full capacity
   * @param key Bucket identifier
   */
  async reset(key: string): Promise<void> {
    try {
      const redisKey = `${this.keyPrefix}:${key}`;
      await this.redis.del(redisKey);
    } catch (err) {
      logger.error({ err, key }, 'Token bucket reset failed');
      throw err;
    }
  }

  /**
   * Gets the current state of a bucket without consuming tokens
   * @param key Bucket identifier
   */
  async getState(
    key: string,
  ): Promise<{
    tokensAvailable: number;
    capacity: number;
    nextRefillAt: number;
    isEmpty: boolean;
  }> {
    try {
      const redisKey = `${this.keyPrefix}:${key}`;
      const bucket = await this.redis.hgetall(redisKey);

      if (!bucket || Object.keys(bucket).length === 0) {
        return {
          tokensAvailable: this.config.capacity,
          capacity: this.config.capacity,
          nextRefillAt: Date.now() + this.config.refillInterval,
          isEmpty: false,
        };
      }

      const lastRefill = Number(bucket.last_refill) || Date.now();
      const tokens = Math.min(this.config.capacity, Number(bucket.tokens) || 0);
      const elapsed = Date.now() - lastRefill;
      const refills = Math.floor(elapsed / this.config.refillInterval);
      const tokensAfterRefill = Math.min(
        this.config.capacity,
        tokens + refills * this.config.tokensPerInterval,
      );

      const timeSinceLastRefill = elapsed % this.config.refillInterval;
      const nextRefillAt = Date.now() + (this.config.refillInterval - timeSinceLastRefill);

      return {
        tokensAvailable: tokensAfterRefill,
        capacity: this.config.capacity,
        nextRefillAt,
        isEmpty: tokensAfterRefill === 0,
      };
    } catch (err) {
      logger.error({ err, key }, 'Failed to get token bucket state');
      throw err;
    }
  }

  /**
   * Preemptively refills tokens to handle traffic spikes
   * Useful for privileged users or burst traffic handling
   * @param key Bucket identifier
   * @param tokensToAdd Number of tokens to add
   */
  async addTokens(key: string, tokensToAdd: number): Promise<number> {
    if (!Number.isInteger(tokensToAdd) || tokensToAdd <= 0) {
      throw new RangeError('tokensToAdd must be a positive integer');
    }

    try {
      const redisKey = `${this.keyPrefix}:${key}`;
      const bucket = await this.redis.hgetall(redisKey);

      const currentTokens = Math.min(this.config.capacity, Number(bucket.tokens) || 0);
      const newTokens = Math.min(this.config.capacity, currentTokens + tokensToAdd);
      const added = newTokens - currentTokens;

      if (added > 0) {
        await this.redis.hset(redisKey, 'tokens', newTokens);
        await this.redis.expire(redisKey, Math.ceil(this.config.refillInterval / 1000) + 3600);
      }

      return added;
    } catch (err) {
      logger.error({ err, key, tokensToAdd }, 'Failed to add tokens to bucket');
      throw err;
    }
  }

  /**
   * Removes all buckets matching a pattern (useful for cleanup)
   * @param pattern Redis key pattern (e.g., "user:123:*")
   */
  async clearBucketsWithPattern(pattern: string): Promise<number> {
    try {
      const redisPattern = `${this.keyPrefix}:${pattern}`;
      const keys = await this.redis.keys(redisPattern);
      if (keys.length === 0) return 0;

      const deleted = await this.redis.del(...keys);
      logger.info({ pattern, deleted }, 'Cleared token buckets');
      return deleted;
    } catch (err) {
      logger.error({ err, pattern }, 'Failed to clear buckets with pattern');
      throw err;
    }
  }
}

/**
 * Creates a token bucket limiter factory with preset configurations
 */
export const tokenBucketPresets = {
  /**
   * Tight limit for sensitive operations (login, password reset, etc.)
   * 5 requests per 60 seconds with burst of 2
   */
  sensitive: (): TokenBucketConfig => ({
    capacity: 2,
    tokensPerInterval: 5,
    refillInterval: 60_000,
  }),

  /**
   * Standard limit for authenticated user operations
   * 100 requests per 60 seconds with burst of 20
   */
  standard: (): TokenBucketConfig => ({
    capacity: 20,
    tokensPerInterval: 100,
    refillInterval: 60_000,
  }),

  /**
   * Generous limit for public endpoints
   * 1000 requests per 60 seconds with burst of 200
   */
  generous: (): TokenBucketConfig => ({
    capacity: 200,
    tokensPerInterval: 1000,
    refillInterval: 60_000,
  }),

  /**
   * Very tight limit for resource-intensive operations
   * 10 requests per 60 seconds with burst of 2
   */
  heavyCompute: (): TokenBucketConfig => ({
    capacity: 2,
    tokensPerInterval: 10,
    refillInterval: 60_000,
  }),

  /**
   * Custom configuration builder
   */
  custom: (
    capacity: number,
    tokensPerInterval: number,
    refillInterval: number = 60_000,
  ): TokenBucketConfig => ({
    capacity,
    tokensPerInterval,
    refillInterval,
  }),
};
