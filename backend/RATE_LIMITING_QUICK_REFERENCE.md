# Rate Limiting - Quick Reference Card

## Installation (1 line)

```typescript
// src/index.ts
app.use(createTokenBucketRateLimitMiddleware({ redis }));
```

## Admin Dashboard (1 line)

```typescript
app.use('/api/admin/rate-limits', rateLimitAdminRouter);
```

## Configuration Presets

```typescript
import { tokenBucketPresets } from './services/token-bucket-limiter';

sensitive()      // 5/min, burst 2  → Login, MFA, password reset
standard()       // 100/min, burst 20 → Authenticated users
generous()       // 1000/min, burst 200 → Public endpoints
heavyCompute()   // 10/min, burst 2 → Resource-intensive ops
custom(50, 200)  // Custom: 200/min, burst 50
```

## Protect Single Route

```typescript
router.post('/api/critical',
  protectWithTokenBucket(redis, tokenBucketPresets.sensitive()),
  handler
);
```

## HTTP Response Headers

### Allowed
```
RateLimit-Limit: 100
RateLimit-Remaining: 85
RateLimit-Reset: 1700000000
Retry-After: (not set)
```

### Denied (429)
```
RateLimit-Limit: 100
RateLimit-Remaining: 0
RateLimit-Reset: 1700000045
Retry-After: 45
```

## Admin API Endpoints

```bash
# View metrics
curl http://localhost:3000/api/admin/rate-limits/metrics

# View for specific date
curl http://localhost:3000/api/admin/rate-limits/metrics/2024-01-15

# Endpoint stats
curl http://localhost:3000/api/admin/rate-limits/endpoints/POST%20%2Fapi%2Fusers/stats

# Anomalies
curl http://localhost:3000/api/admin/rate-limits/anomalies

# View bucket state
curl http://localhost:3000/api/admin/rate-limits/bucket/user:123

# Reset user
curl -X POST http://localhost:3000/api/admin/rate-limits/reset/user:123

# Reset pattern
curl -X POST http://localhost:3000/api/admin/rate-limits/reset-pattern/user:123:*

# Give quota
curl -X POST http://localhost:3000/api/admin/rate-limits/quota/allocate \
  -d '{"key":"user:123","tokensToAdd":500,"durationMs":3600000}'

# Revoke quota
curl -X DELETE http://localhost:3000/api/admin/rate-limits/quota/user:123

# Cleanup
curl -X POST http://localhost:3000/api/admin/rate-limits/cleanup?daysToKeep=7
```

## Key Strategies

```typescript
'ip'        // Track by client IP
'userId'    // Track by authenticated user
'api-key'   // Track by API key
'combined'  // Track by both user and IP (defense-in-depth)
'global'    // Single global limit for entire service
```

## Custom Policy

```typescript
{
  path: '/api/endpoint',
  methods: ['POST'],
  config: {
    capacity: 50,              // Burst: 50 tokens
    tokensPerInterval: 200,    // Rate: 200/minute
    refillInterval: 60_000     // Refill every 60 seconds
  },
  keyStrategy: 'userId',
  bypass: (context) => context.isAdmin,
  description: 'My endpoint - 200 per minute with burst of 50'
}
```

## Error Handling

```typescript
// If Redis down → Allow all requests (safe fallback)
// If policy matched but bypassed → Allow (no limit applied)
// If tokens available → Allow, consume tokens
// If tokens unavailable → Deny 429, return Retry-After
```

## Testing

```bash
# Run tests
npm test -- token-bucket-limiter.test.ts

# Load test
ab -n 10000 -c 100 http://localhost:3000/api/users

# Check headers
curl -v http://localhost:3000/health
```

## Monitoring

```typescript
const monitor = new RateLimitMonitor(redis);

// Get metrics
const metrics = await monitor.getMetrics();
console.log(`${metrics.deniedRequests} requests denied`);

// Get endpoint stats
const stats = await monitor.getEndpointStats('/api/users');
console.log(`Denial rate: ${(stats.denialRate * 100).toFixed(2)}%`);

// List anomalies
const anomalies = await monitor.listAnomalies();
anomalies.forEach(a => console.log(`${a.key}: ${a.denials} denials`));

// Auto-cleanup
monitor.startPeriodicCleanup(86400000); // Every 24 hours
```

## Quota Management

```typescript
const quotaManager = new RateLimitQuotaManager(redis);

// Give emergency quota
await quotaManager.allocateQuota('user:123', 500, 3600000);

// Check remaining quota
const quota = await quotaManager.getQuota('user:123');

// Revoke quota
await quotaManager.revokeQuota('user:123');
```

## Bucket Operations

```typescript
const limiter = new TokenBucketLimiter(redis, config);

// Check if request allowed
const result = await limiter.consume('user:123', 1);
if (result.allowed) {
  console.log(`${result.tokensRemaining} tokens left`);
} else {
  console.log(`Retry after ${result.retryAfter}ms`);
}

// View state
const state = await limiter.getState('user:123');
console.log(`${state.tokensAvailable}/${state.capacity}`);

// Add tokens
const added = await limiter.addTokens('user:123', 100);

// Reset
await limiter.reset('user:123');

// Bulk operations
const deleted = await limiter.clearBucketsWithPattern('user:*');
```

## Troubleshooting

### Too many 429s?
1. Check: `GET /api/admin/rate-limits/metrics`
2. See top blocked: Check `topBlockedUsers` field
3. Solution: `POST /api/admin/rate-limits/quota/allocate`

### Not rate limiting?
1. Verify middleware added before routes
2. Check path matches policy
3. Test: `for i in {1..20}; do curl http://localhost:3000/health; done`

### Redis connection failed?
- Requests pass through (safe fallback)
- Check: `curl http://localhost:3000/health | grep redis`
- Verify: `redis-cli ping`

## Default Limits

| Path | Limit | Burst | Strategy |
|------|-------|-------|----------|
| /auth/login | 5/min | 2 | IP |
| /auth/register | 5/min | 2 | IP |
| /api/users (GET) | 100/min | 20 | Combined |
| /api/users (Write) | 20/min | 10 | User |
| /api/markets | 1000/min | 200 | IP |
| /api/claims/create | 20/min | 5 | User |
| /wallet/withdraw | 2/min | 1 | User |
| /api/admin/* | 100/min | 50 | Combined |

## Documentation

- **Quick Start**: `docs/RATE_LIMITING_QUICKSTART.md`
- **Full Guide**: `docs/RATE_LIMITING.md`
- **Architecture**: `docs/RATE_LIMITING_ARCHITECTURE.md`
- **Summary**: `docs/RATE_LIMITING_IMPLEMENTATION_SUMMARY.md`
- **This File**: `RATE_LIMITING_QUICK_REFERENCE.md`
- **Manifest**: `RATE_LIMITING_MANIFEST.md`

## Code Examples

### Example 1: Sensitive Endpoint
```typescript
app.post('/api/change-password',
  protectWithTokenBucket(redis, tokenBucketPresets.sensitive()),
  async (req, res) => { ... }
);
```

### Example 2: Admin Override
```typescript
{
  path: '/api/users/*/delete',
  config: tokenBucketPresets.heavyCompute(),
  keyStrategy: 'userId',
  bypass: (context) => context.isAdmin,
}
```

### Example 3: Monitor Abuse
```typescript
const metrics = await monitor.getMetrics();
if (metrics.denialRate > 0.05) {
  console.warn('High denial rate detected!');
  const anomalies = await monitor.listAnomalies();
  console.log(anomalies);
}
```

### Example 4: Gradual Quota Increase
```typescript
// Give premium users 10x limit
if (user.tier === 'premium') {
  await quotaManager.allocateQuota(
    `user:${user.id}`,
    5000,  // Extra tokens
    3600000  // For 1 hour
  );
}
```

---

**For more information:** See full documentation in `docs/` directory
