# Sophisticated Rate Limiting with Token Bucket Algorithm

This guide explains the advanced rate limiting system implemented in the StellarFox backend using the token bucket algorithm with Redis for distributed synchronization.

## Overview

The token bucket algorithm provides a sophisticated approach to rate limiting that:

- **Handles traffic spikes**: Allows controlled burst traffic through token accumulation
- **Smooth throttling**: Distributes tokens at a constant rate to encourage steady consumption
- **Per-endpoint granularity**: Different endpoints can have different limits
- **Distributed consistency**: Uses Redis for multi-instance synchronization
- **Low overhead**: Atomic Redis operations ensure consistency without complex locking

## Architecture

### Components

1. **TokenBucketLimiter** (`src/services/token-bucket-limiter.ts`)
   - Core rate limiting engine
   - Manages token bucket state in Redis
   - Atomic operations using Lua scripts
   - Preset configurations for common scenarios

2. **Rate Limit Configuration** (`src/config/rate-limit-config.ts`)
   - Per-endpoint policies
   - Path matching with wildcard support
   - Configurable key strategies (IP, user ID, combined)
   - Bypass rules for privileged requests

3. **Token Bucket Middleware** (`src/middleware/token-bucket-rate-limit.middleware.ts`)
   - Express middleware for automatic rate limiting
   - Response header generation
   - Error handling and fallback

4. **Monitoring & Management** (`src/utils/rate-limit-monitor.ts`)
   - Real-time metrics collection
   - Anomaly detection
   - Quota management for temporary overrides

5. **Admin Routes** (`src/routes/rate-limit-admin.routes.ts`)
   - Admin endpoints for metrics and management
   - Quota allocation/revocation
   - Manual bucket resets

## Token Bucket Algorithm

### How It Works

The token bucket algorithm operates on these principles:

```
┌─────────────────────────────────────────┐
│          Token Bucket (capacity=20)      │
│  Tokens: ████████░░░░  (12/20)          │
│  Refills: 100 tokens/min                │
└─────────────────────────────────────────┘

Request arrives:
  ✓ 1 token available → Allow request, consume 1 token
  ✗ 0 tokens available → Deny request, return Retry-After

Tokens refill every 60 seconds:
  - Add `tokensPerInterval` tokens to bucket
  - Cap at `capacity` (burst limit)
```

### Configuration Parameters

- **capacity**: Maximum tokens in bucket (burst allowance)
- **tokensPerInterval**: Tokens added per refill interval
- **refillInterval**: Time between token additions (milliseconds)

### Example Configurations

**Standard authenticated endpoint (100 req/min, burst of 20):**
```
capacity: 20
tokensPerInterval: 100
refillInterval: 60_000 (1 minute)
```

**Sensitive operation like login (5 req/min, burst of 2):**
```
capacity: 2
tokensPerInterval: 5
refillInterval: 60_000
```

**High-throughput public endpoint (1000 req/min, burst of 200):**
```
capacity: 200
tokensPerInterval: 1000
refillInterval: 60_000
```

## Integration

### 1. Basic Setup in Express App

```typescript
import { createTokenBucketRateLimitMiddleware } from './middleware/token-bucket-rate-limit.middleware';
import { redis } from './config/redis';
import { defaultRateLimitPolicies } from './config/rate-limit-config';

const app = express();

// Apply middleware to entire app or specific routes
app.use(createTokenBucketRateLimitMiddleware({
  redis,
  policies: defaultRateLimitPolicies,
  enableDetailedHeaders: true,
  enableLogging: true,
}));

// Or apply to specific route
import { protectWithTokenBucket } from './middleware/token-bucket-rate-limit.middleware';
import { tokenBucketPresets } from './services/token-bucket-limiter';

app.post('/api/sensitive-operation', 
  protectWithTokenBucket(redis, tokenBucketPresets.sensitive()),
  handler
);
```

### 2. Add Admin Routes

```typescript
import rateLimitAdminRouter from './routes/rate-limit-admin.routes';

app.use('/api/admin/rate-limits', rateLimitAdminRouter);
```

### 3. Custom Policies

```typescript
import { EndpointRateLimitPolicy } from './config/rate-limit-config';

const customPolicies: EndpointRateLimitPolicy[] = [
  {
    path: '/api/custom-endpoint',
    methods: ['POST'],
    config: {
      capacity: 50,
      tokensPerInterval: 200,
      refillInterval: 60_000,
    },
    keyStrategy: 'combined', // Track by both user ID and IP
    description: 'Custom endpoint - 200 per minute with burst of 50',
    bypass: (context) => context.isAdmin, // Admins bypass
  },
];

app.use(createTokenBucketRateLimitMiddleware({
  redis,
  policies: customPolicies,
}));
```

## Response Headers

The middleware automatically sets comprehensive rate limit headers:

### Standard Headers (RFC 6585)
```
RateLimit-Limit: 100           # Max requests in window
RateLimit-Remaining: 85        # Tokens remaining
RateLimit-Reset: 1700000000    # Unix timestamp when limit resets
```

### Legacy Headers (AWS style)
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 85
X-RateLimit-Reset: 1700000000
```

### Detailed Headers
```
X-RateLimit-Retry-After: 45           # Seconds until next token available
X-RateLimit-Reset-After: 60           # Seconds until bucket full
X-RateLimit-Tokens-Per-Interval: 100  # Refill rate
X-RateLimit-Refill-Interval: 60000    # Refill period in ms
```

### On Rate Limit Exceeded
```
HTTP/1.1 429 Too Many Requests
Retry-After: 45

{
  "error": "Too Many Requests",
  "details": {
    "retryAfter": 45,
    "policy": "Login attempts - 5 per minute with burst of 2"
  }
}
```

## Admin API

### View Metrics

```bash
# Current day metrics
curl -X GET http://localhost:3000/api/admin/rate-limits/metrics \
  -H "Authorization: Bearer <admin-token>"

# Specific date
curl -X GET http://localhost:3000/api/admin/rate-limits/metrics/2024-01-15 \
  -H "Authorization: Bearer <admin-token>"

# Response
{
  "success": true,
  "data": {
    "totalRequests": 50000,
    "deniedRequests": 1200,
    "denialRate": 0.024,
    "topBlockedUsers": [
      { "key": "user:456", "deniedCount": 85 },
      { "key": "user:789", "deniedCount": 42 }
    ],
    "topBlockedIps": [
      { "ip": "192.168.1.100", "deniedCount": 120 }
    ]
  }
}
```

### Endpoint Statistics

```bash
curl -X GET http://localhost:3000/api/admin/rate-limits/endpoints/POST%20%2Fapi%2Fusers/stats
```

### Detect Anomalies

```bash
curl -X GET http://localhost:3000/api/admin/rate-limits/anomalies
```

### Allocate Emergency Quota

```bash
curl -X POST http://localhost:3000/api/admin/rate-limits/quota/allocate \
  -H "Content-Type: application/json" \
  -d '{
    "key": "user:123",
    "tokensToAdd": 500,
    "durationMs": 3600000
  }'
```

### Reset Rate Limit for User

```bash
curl -X POST http://localhost:3000/api/admin/rate-limits/reset/user:123
```

### Reset Buckets by Pattern

```bash
# Reset all buckets for a specific user across all endpoints
curl -X POST http://localhost:3000/api/admin/rate-limits/reset-pattern/user:123:*

# Reset all API requests from a specific IP
curl -X POST http://localhost:3000/api/admin/rate-limits/reset-pattern/ip:192.168.1.100:*
```

### View Bucket State

```bash
curl -X GET http://localhost:3000/api/admin/rate-limits/bucket/user:123
```

## Monitoring and Metrics

### Built-in Metrics

The system automatically tracks:

- Total requests per endpoint per day
- Denied requests and denial rates
- Top blocked users and IPs
- Anomalies (unusual spike in denials)
- Per-endpoint statistics
- Retry-after distribution

### Integration with Prometheus

Export metrics for Prometheus scraping:

```bash
curl http://localhost:3000/metrics
```

### Real-time Anomaly Detection

Anomalies are automatically detected when:
- A single key exceeds 100 denials in a day
- Denial rate spikes above threshold
- Specific endpoints show unusual patterns

Anomalies are logged and can be queried via admin API.

## Key Strategies

### 1. IP-Based Limiting
```typescript
keyStrategy: 'ip'
// Key format: "ip:192.168.1.1"
```
Best for: Public endpoints, brute-force protection

### 2. User ID-Based Limiting
```typescript
keyStrategy: 'userId'
// Key format: "user:123"
```
Best for: Authenticated endpoints, per-user quotas

### 3. API Key-Based Limiting
```typescript
keyStrategy: 'api-key'
// Key format: "key:sk_xxx"
```
Best for: Third-party integrations, service accounts

### 4. Combined Strategy
```typescript
keyStrategy: 'combined'
// Key format: "combined:user:123:192.168.1.1"
```
Best for: Defense-in-depth, sensitive operations

Tracks both user identity and source IP, preventing attacks where:
- A single user hammers from multiple IPs
- Multiple users attack from a single IP

### 5. Global Limiting
```typescript
keyStrategy: 'global'
// Key format: "global"
```
Best for: Health checks, rate limiting entire service

## Bypass Rules

Requests can automatically bypass rate limiting using the `bypass` function:

```typescript
{
  path: '/wallet/withdraw',
  config: { ... },
  keyStrategy: 'userId',
  bypass: (context) => {
    // Admins and internal services bypass
    return context.isAdmin || context.isService;
  }
}
```

Context properties available:
- `method`: HTTP method
- `path`: Request path
- `ip`: Client IP
- `userId`: Authenticated user ID
- `apiKey`: API key (if applicable)
- `isAdmin`: Admin flag
- `isService`: Internal service flag

## Quota Management

### Allocate Temporary Quota

Useful for giving trusted users or services burst capacity:

```typescript
const quotaManager = new RateLimitQuotaManager(redis);

// Give user 500 extra tokens for 1 hour
await quotaManager.allocateQuota('user:123', 500, 3600000);
```

### Manual Token Addition

Directly add tokens to a bucket:

```typescript
const limiter = new TokenBucketLimiter(redis, config);

// Add 100 tokens to a bucket
const added = await limiter.addTokens('user:456', 100);
console.log(`Added ${added} tokens`);
```

## Production Considerations

### 1. Redis High Availability

Ensure Redis is configured with:
- Replication (master-slave)
- Persistence (AOF or RDB)
- Sentinel for automatic failover
- Cluster mode for horizontal scaling

### 2. Monitoring

Set up alerts for:
- Denial rate spikes (possible attack)
- Redis connection failures
- High latency on rate limit checks
- Memory usage of rate limit keys

### 3. Configuration Tuning

Adjust based on observed traffic:

```typescript
// Analyze metrics to find optimal settings
const metrics = await monitor.getMetrics();

// If denial rate > 5%, increase tokens or capacity
// If denial rate < 0.5%, consider decreasing for stricter limits
```

### 4. Cleanup

Automatically clean up old metrics:

```typescript
monitor.startPeriodicCleanup(86400000); // Every 24 hours
// Keeps 7 days of metrics by default
```

### 5. Performance

The token bucket implementation is optimized:
- Single Lua script per request (atomic)
- O(1) Redis operations
- Minimal network overhead
- Negligible latency impact (~1-5ms)

## Troubleshooting

### High Rate Limit Rejections

1. Check denial rate: `GET /api/admin/rate-limits/metrics`
2. Identify top blocked users: See response `topBlockedUsers`
3. Check if legitimate user: Review endpoint statistics
4. Options:
   - Allocate quota increase
   - Adjust endpoint policy
   - Add bypass rule

### Requests Being Delayed

Check Redis latency:
```bash
redis-cli --latency
```

If Redis is slow:
- Check memory usage
- Monitor key expiration
- Consider cluster mode

### Bucket Not Resetting

Verify Redis state:
```bash
# Get bucket state
curl http://localhost:3000/api/admin/rate-limits/bucket/user:123

# If stuck, manual reset
curl -X POST http://localhost:3000/api/admin/rate-limits/reset/user:123
```

## Examples

### Example 1: Protect Sensitive Endpoint

```typescript
import { protectWithTokenBucket } from './middleware/token-bucket-rate-limit.middleware';
import { tokenBucketPresets } from './services/token-bucket-limiter';

router.post('/password-reset',
  protectWithTokenBucket(redis, tokenBucketPresets.sensitive()),
  async (req, res) => {
    // Handle password reset
  }
);
```

### Example 2: Graduated Limits by User Role

```typescript
const policies: EndpointRateLimitPolicy[] = [
  {
    path: '/api/data/export',
    config: {
      capacity: 5,
      tokensPerInterval: 10,
      refillInterval: 60_000,
    },
    keyStrategy: 'userId',
    bypass: (context) => {
      // Premium users get 10x limit
      return context.user?.tier === 'premium';
    },
  },
];
```

### Example 3: Monitor for Abuse

```typescript
app.use(async (req, res, next) => {
  res.on('finish', async () => {
    if (res.statusCode === 429) {
      const rateLimitInfo = getRateLimitInfo(req);
      await monitor.recordDenial(
        rateLimitInfo.key,
        req.path,
        rateLimitInfo.result.retryAfter
      );
    }
  });
  next();
});
```

## Testing

Run the test suite:

```bash
npm test -- token-bucket-limiter.test.ts
```

Tests cover:
- Token consumption and refilling
- Burst capacity handling
- Multiple bucket isolation
- State management
- Quota allocation
- Metrics collection
- Anomaly detection

## References

- Token Bucket Algorithm: https://en.wikipedia.org/wiki/Token_bucket
- RFC 6585 (HTTP 429): https://tools.ietf.org/html/rfc6585
- Rate Limiting Patterns: https://cloud.google.com/solutions/rate-limiting-strategies-techniques
- Redis Lua Scripting: https://redis.io/commands/eval/
