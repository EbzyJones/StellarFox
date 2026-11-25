/**
 * Per-Endpoint Rate Limit Configuration
 * 
 * Defines granular rate limiting policies for different endpoint categories
 * and traffic patterns. Can be extended or overridden per environment.
 */

import { TokenBucketConfig, tokenBucketPresets } from '../services/token-bucket-limiter';

export interface EndpointRateLimitPolicy {
  /** Route path pattern (supports wildcards) */
  path: string;
  /** HTTP methods to apply limit to (empty = all) */
  methods?: string[];
  /** Token bucket configuration */
  config: TokenBucketConfig;
  /** Key generation strategy */
  keyStrategy: 'ip' | 'userId' | 'api-key' | 'global' | 'combined';
  /** Whether to bypass the limiter for specific conditions */
  bypass?: (context: RateLimitContext) => boolean;
  /** Description for monitoring/logging */
  description?: string;
}

export interface RateLimitContext {
  method: string;
  path: string;
  ip: string;
  userId?: string;
  apiKey?: string;
  isAdmin?: boolean;
  isService?: boolean;
}

/**
 * Default rate limit policies for common endpoint categories
 */
export const defaultRateLimitPolicies: EndpointRateLimitPolicy[] = [
  // Authentication endpoints - very strict
  {
    path: '/auth/login',
    methods: ['POST'],
    config: tokenBucketPresets.sensitive(),
    keyStrategy: 'ip',
    description: 'Login attempts - 5 per minute with burst of 2',
  },
  {
    path: '/auth/register',
    methods: ['POST'],
    config: tokenBucketPresets.sensitive(),
    keyStrategy: 'ip',
    description: 'Registration attempts - 5 per minute with burst of 2',
  },
  {
    path: '/auth/password-reset',
    methods: ['POST'],
    config: tokenBucketPresets.sensitive(),
    keyStrategy: 'ip',
    description: 'Password reset - 5 per minute with burst of 2',
  },
  {
    path: '/auth/mfa/verify',
    methods: ['POST'],
    config: tokenBucketPresets.sensitive(),
    keyStrategy: 'userId',
    description: 'MFA verification - 5 attempts per minute with burst of 2',
  },

  // API endpoints - standard limit for authenticated users
  {
    path: '/api/users/*',
    methods: ['GET'],
    config: tokenBucketPresets.standard(),
    keyStrategy: 'combined', // Combine userId and IP for better security
    description: 'User profile endpoints - 100 per minute with burst of 20',
  },
  {
    path: '/api/users/*',
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    config: {
      capacity: 10,
      tokensPerInterval: 20,
      refillInterval: 60_000,
    },
    keyStrategy: 'userId',
    description: 'User modification endpoints - 20 per minute with burst of 10',
  },

  // Market data endpoints - generous for public data
  {
    path: '/api/markets',
    methods: ['GET'],
    config: tokenBucketPresets.generous(),
    keyStrategy: 'ip',
    description: 'Market data - 1000 per minute with burst of 200',
  },
  {
    path: '/api/markets/:id',
    methods: ['GET'],
    config: tokenBucketPresets.generous(),
    keyStrategy: 'ip',
    description: 'Market detail - 1000 per minute with burst of 200',
  },

  // Trading endpoints - moderate, per-user limit
  {
    path: '/api/claims/create',
    methods: ['POST'],
    config: {
      capacity: 5,
      tokensPerInterval: 20,
      refillInterval: 60_000,
    },
    keyStrategy: 'userId',
    description: 'Create claim/bet - 20 per minute with burst of 5',
  },
  {
    path: '/api/claims/:id/resolve',
    methods: ['POST'],
    config: tokenBucketPresets.heavyCompute(),
    keyStrategy: 'userId',
    description: 'Resolve claim - 10 per minute with burst of 2',
  },

  // Withdrawal endpoints - very strict
  {
    path: '/wallet/withdraw',
    methods: ['POST'],
    config: {
      capacity: 1,
      tokensPerInterval: 2,
      refillInterval: 60_000,
    },
    keyStrategy: 'userId',
    description: 'Withdrawals - 2 per minute with burst of 1',
    bypass: (context) => context.isAdmin === true, // Admins bypass
  },

  // Admin endpoints - strict per admin
  {
    path: '/api/admin/*',
    config: {
      capacity: 50,
      tokensPerInterval: 100,
      refillInterval: 60_000,
    },
    keyStrategy: 'combined',
    description: 'Admin operations - 100 per minute with burst of 50',
    bypass: (context) => context.isService === true, // Internal services bypass
  },

  // Batch operations - moderate, encourage batching
  {
    path: '/api/batch',
    methods: ['POST'],
    config: {
      capacity: 10,
      tokensPerInterval: 30,
      refillInterval: 60_000,
    },
    keyStrategy: 'userId',
    description: 'Batch operations - 30 per minute with burst of 10',
  },

  // WebSocket endpoints - permissive for real-time updates
  {
    path: '/ws',
    config: tokenBucketPresets.generous(),
    keyStrategy: 'userId',
    description: 'WebSocket connections - 1000 per minute with burst of 200',
  },

  // Health check - no limit
  {
    path: '/health',
    methods: ['GET'],
    config: {
      capacity: 1000,
      tokensPerInterval: 10000,
      refillInterval: 60_000,
    },
    keyStrategy: 'global',
    description: 'Health checks - no practical limit',
  },

  // Metrics export - limited access
  {
    path: '/metrics',
    methods: ['GET'],
    config: {
      capacity: 10,
      tokensPerInterval: 20,
      refillInterval: 60_000,
    },
    keyStrategy: 'ip',
    bypass: (context) => context.isService === true,
    description: 'Metrics endpoint - 20 per minute with burst of 10',
  },
];

/**
 * Rate limit policy matcher
 * Finds the matching policy for a given context
 */
export function findMatchingPolicy(
  context: RateLimitContext,
  policies: EndpointRateLimitPolicy[] = defaultRateLimitPolicies,
): EndpointRateLimitPolicy | null {
  // Sort by specificity (longer paths first)
  const sorted = [...policies].sort((a, b) => b.path.length - a.path.length);

  for (const policy of sorted) {
    if (pathMatches(context.path, policy.path)) {
      if (policy.methods && !policy.methods.includes(context.method.toUpperCase())) {
        continue;
      }
      if (policy.bypass && policy.bypass(context)) {
        return null; // Policy matched but bypassed
      }
      return policy;
    }
  }

  return null;
}

/**
 * Simple path matching with wildcard support
 * Examples:
 * - "/api/users" matches "/api/users"
 * - "/api/users/*" matches "/api/users/123" or "/api/users/profile"
 * - "/api/users/:id" matches "/api/users/123" or "/api/users/john"
 */
export function pathMatches(actual: string, pattern: string): boolean {
  // Exact match
  if (actual === pattern) return true;

  // Replace wildcard patterns with regex
  const regexPattern = pattern
    .replace(/\*/g, '[^/]+') // * matches any characters except /
    .replace(/:[a-zA-Z_]+/g, '[^/]+'); // :param matches any characters except /

  const regex = new RegExp(`^${regexPattern}(/.*)?$`);
  return regex.test(actual);
}

/**
 * Generates a rate limit key based on the strategy
 */
export function generateRateLimitKey(
  context: RateLimitContext,
  strategy: EndpointRateLimitPolicy['keyStrategy'],
): string {
  switch (strategy) {
    case 'ip':
      return `ip:${context.ip}`;
    case 'userId':
      return `user:${context.userId || context.ip}`;
    case 'api-key':
      return `key:${context.apiKey || context.userId || context.ip}`;
    case 'combined':
      // Combine userId and IP for defense-in-depth
      return `combined:${context.userId || 'anon'}:${context.ip}`;
    case 'global':
      return 'global';
    default:
      return `unknown:${context.ip}`;
  }
}

/**
 * Preset configurations for common scenarios
 */
export const rateLimitPresets = {
  /**
   * Strict security-focused configuration
   * Tight limits on sensitive operations, permissive on reads
   */
  security: {
    defaultConfig: tokenBucketPresets.sensitive(),
    policies: defaultRateLimitPolicies.map((p) => ({
      ...p,
      config: p.path.includes('auth') ? tokenBucketPresets.sensitive() : p.config,
    })),
  },

  /**
   * Balanced configuration suitable for most applications
   */
  balanced: {
    defaultConfig: tokenBucketPresets.standard(),
    policies: defaultRateLimitPolicies,
  },

  /**
   * Permissive configuration for high-throughput scenarios
   */
  highThroughput: {
    defaultConfig: tokenBucketPresets.generous(),
    policies: defaultRateLimitPolicies.map((p) => ({
      ...p,
      config: {
        ...p.config,
        tokensPerInterval: p.config.tokensPerInterval * 2,
        capacity: Math.ceil(p.config.capacity * 1.5),
      },
    })),
  },

  /**
   * Development configuration - very permissive
   */
  development: {
    defaultConfig: {
      capacity: 10000,
      tokensPerInterval: 100000,
      refillInterval: 60_000,
    },
    policies: [],
  },
};
