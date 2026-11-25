/**
 * Token Bucket Rate Limit Middleware
 * 
 * Advanced rate limiting middleware using the token bucket algorithm
 * Supports:
 * - Per-endpoint granular configuration
 * - Flexible key strategies (IP, user ID, API key, combined)
 * - Automatic bypass for admin/service accounts
 * - Detailed rate limit headers
 * - Request queueing strategies for rejected requests
 */

import type { Request, Response, NextFunction } from 'express';
import type Redis from 'ioredis';
import { TokenBucketLimiter, TokenBucketConfig } from '../services/token-bucket-limiter';
import {
  findMatchingPolicy,
  generateRateLimitKey,
  defaultRateLimitPolicies,
  RateLimitContext,
  EndpointRateLimitPolicy,
} from '../config/rate-limit-config';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

export interface TokenBucketMiddlewareOptions {
  redis: Redis;
  policies?: EndpointRateLimitPolicy[];
  defaultConfig?: TokenBucketConfig;
  enableDetailedHeaders?: boolean;
  enableLogging?: boolean;
  keyPrefix?: string;
}

/**
 * Creates token bucket rate limit middleware with per-endpoint policies
 */
export function createTokenBucketRateLimitMiddleware(
  options: TokenBucketMiddlewareOptions,
) {
  const {
    redis,
    policies = defaultRateLimitPolicies,
    defaultConfig = {
      capacity: 100,
      tokensPerInterval: 1000,
      refillInterval: 60_000,
    },
    enableDetailedHeaders = true,
    enableLogging = process.env.NODE_ENV === 'development',
    keyPrefix = 'token-bucket',
  } = options;

  const limiter = new TokenBucketLimiter(redis, {
    ...defaultConfig,
    keyPrefix,
  });

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Build context for policy matching
      const context = buildRateLimitContext(req);

      // Find matching policy
      const policy = findMatchingPolicy(context, policies);

      // If no policy or bypassed, continue
      if (!policy) {
        return next();
      }

      // Generate rate limit key
      const key = generateRateLimitKey(context, policy.keyStrategy);

      // Create a limiter instance with the policy config
      const policyLimiter = new TokenBucketLimiter(redis, {
        ...policy.config,
        keyPrefix,
      });

      // Consume tokens
      const result = await policyLimiter.consume(key, 1);

      // Set rate limit headers
      setRateLimitHeaders(res, result, policy.config, enableDetailedHeaders);

      if (enableLogging && process.env.DEBUG_RATE_LIMIT === 'true') {
        logger.debug(
          {
            path: req.path,
            method: req.method,
            key,
            policy: policy.description,
            allowed: result.allowed,
            tokensRemaining: result.tokensRemaining,
            capacity: policy.config.capacity,
          },
          'Rate limit check',
        );
      }

      // If not allowed, return 429 error
      if (!result.allowed) {
        const retryAfter = Math.ceil(result.retryAfter / 1000);
        res.set('Retry-After', String(retryAfter));

        if (enableLogging) {
          logger.warn(
            {
              path: req.path,
              key,
              policy: policy.description,
              retryAfter,
            },
            'Rate limit exceeded',
          );
        }

        // Add context to AppError for better error handling
        const error = AppError.tooManyRequests('Rate limit exceeded', undefined, {
          retryAfter,
          policy: policy.description,
        });
        return next(error);
      }

      // Store rate limit info on request for downstream handlers
      (req as any).rateLimit = {
        policy,
        key,
        result,
      };

      next();
    } catch (err) {
      logger.error({ err }, 'Token bucket rate limit middleware error');
      // On error, allow request to pass through
      // This prevents rate limiting from blocking traffic if Redis fails
      next();
    }
  };
}

/**
 * Builds the rate limit context from an Express request
 */
function buildRateLimitContext(req: Request): RateLimitContext {
  const authenticatedReq = req as Request & {
    userId?: string;
    user?: { id?: string; userId?: string };
    apiKey?: string;
    isAdmin?: boolean;
    isService?: boolean;
  };

  return {
    method: req.method,
    path: req.path,
    ip: getClientIp(req),
    userId:
      authenticatedReq.userId ??
      authenticatedReq.user?.userId ??
      authenticatedReq.user?.id,
    apiKey: authenticatedReq.apiKey,
    isAdmin: authenticatedReq.isAdmin,
    isService: authenticatedReq.isService,
  };
}

/**
 * Extracts the real client IP from the request
 * Handles proxies and X-Forwarded-For headers
 */
function getClientIp(req: Request): string {
  // Check X-Forwarded-For header (from proxies)
  const forwardedFor = req.get('X-Forwarded-For');
  if (forwardedFor) {
    const ips = forwardedFor.split(',').map((ip) => ip.trim());
    return ips[0];
  }

  // Check other proxy headers
  const clientIp = req.get('CF-Connecting-IP') || req.get('X-Real-IP');
  if (clientIp) {
    return clientIp;
  }

  // Fallback to request IP
  return req.ip ?? 'unknown';
}

/**
 * Sets rate limit response headers
 */
function setRateLimitHeaders(
  res: Response,
  result: Awaited<ReturnType<TokenBucketLimiter['consume']>>,
  config: TokenBucketConfig,
  enableDetailed: boolean,
): void {
  const now = Date.now();
  const remaining = Math.max(0, result.tokensRemaining);
  const resetIn = Math.ceil((result.resetAt - now) / 1000);

  // Standard RateLimit headers (RFC 6585)
  res.set({
    'RateLimit-Limit': String(config.capacity),
    'RateLimit-Remaining': String(remaining),
    'RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)), // Unix timestamp
  });

  // Legacy X-RateLimit headers (AWS style)
  res.set({
    'X-RateLimit-Limit': String(config.capacity),
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
  });

  if (enableDetailed) {
    // Additional detailed headers for monitoring
    res.set({
      'X-RateLimit-Retry-After': String(result.retryAfter),
      'X-RateLimit-Reset-After': String(resetIn),
      'X-RateLimit-Tokens-Per-Interval': String(config.tokensPerInterval),
      'X-RateLimit-Refill-Interval': String(config.refillInterval),
    });
  }
}

/**
 * Middleware factory for single endpoint rate limiting
 * Useful for protecting specific routes
 */
export function protectWithTokenBucket(
  redis: Redis,
  config: TokenBucketConfig,
  keyStrategy: 'ip' | 'userId' | 'combined' = 'combined',
  keyPrefix: string = 'token-bucket-protect',
) {
  const limiter = new TokenBucketLimiter(redis, { ...config, keyPrefix });

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const context = buildRateLimitContext(req);
      const key = generateRateLimitKey(context, keyStrategy);
      const result = await limiter.consume(key, 1);

      setRateLimitHeaders(res, result, config, true);

      if (!result.allowed) {
        const retryAfter = Math.ceil(result.retryAfter / 1000);
        res.set('Retry-After', String(retryAfter));
        return next(AppError.tooManyRequests('Rate limit exceeded'));
      }

      next();
    } catch (err) {
      logger.error({ err }, 'Token bucket protection middleware error');
      next();
    }
  };
}

/**
 * Utility to get rate limit info from a request
 */
export function getRateLimitInfo(req: Request) {
  return (req as any).rateLimit ?? null;
}

/**
 * Middleware to add detailed rate limit diagnostics
 * Useful for monitoring and debugging
 */
export function rateLimitDiagnosticsMiddleware(redis: Redis, keyPrefix: string = 'token-bucket') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const originalSend = res.send.bind(res);

    res.send = function (data: any) {
      const rateLimitInfo = getRateLimitInfo(req);
      if (rateLimitInfo) {
        // Add diagnostics to response body if it's JSON
        if (typeof data === 'string') {
          try {
            const json = JSON.parse(data);
            json._rateLimitDiagnostics = {
              policy: rateLimitInfo.policy.description,
              strategy: rateLimitInfo.policy.keyStrategy,
              tokensRemaining: rateLimitInfo.result.tokensRemaining,
              resetAt: new Date(rateLimitInfo.result.resetAt).toISOString(),
            };
            return originalSend(JSON.stringify(json));
          } catch {
            // Not JSON, return as-is
          }
        }
      }

      return originalSend(data);
    };

    next();
  };
}
