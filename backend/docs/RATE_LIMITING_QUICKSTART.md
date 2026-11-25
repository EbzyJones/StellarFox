# Rate Limiting Quick Start Guide

Get sophisticated token bucket rate limiting running in 5 minutes.

## Installation

The rate limiting system is fully integrated. No additional dependencies needed beyond what's already in `package.json`:
- `ioredis` - Already required
- `express` - Already required
- `pino` - For logging

## 1. Basic Setup (2 minutes)

Add to your Express app initialization:

```typescript
// src/index.ts
import { createTokenBucketRateLimitMiddleware } from './middleware/token-bucket-rate-limit.middleware';
import { redis } from './config/redis';
import { defaultRateLimitPolicies } from './config/rate-limit-config';

const app = express();

// Apply rate limiting to entire app (after CORS, before routes)
app.use(createTokenBucketRateLimitMiddleware({
  redis,
  policies: defaultRateLimitPolicies,
  enableDetailedHeaders: true,
  enableLogging: process.env.DEBUG_RATE_LIMIT === 'true',
}));

// ... rest of your routes
```

## 2. Add Admin Dashboard (1 minute)

Add admin routes to manage rate limits:

```typescript
// src/index.ts
import rateLimitAdminRouter from './routes/rate-limit-admin.routes';

// After setting up auth middleware
app.use('/api/admin/rate-limits', 
  requireAdmin,  // Your admin auth middleware
  rateLimitAdminRouter
);
```

## 3. Test It (1 minute)

### Start the server
```bash
npm run dev
```

### Send test requests
```bash
# Should succeed
curl -X GET http://localhost:3000/health

# Check rate limit headers
curl -X GET http://localhost:3000/health -v

# Returns 429 after hitting limit
for i in {1..50}; do
  curl -X POST http://localhost:3000/auth/login \
    -d '{"email":"test@test.com","password":"pass"}'
done
```

### View rate limit headers
```bash
# Shows:
# RateLimit-Limit: 2
# RateLimit-Remaining: 0
# RateLimit-Reset: 1700000045
# Retry-After: 45
```

### Check admin metrics
```bash
curl -X GET http://localhost:3000/api/admin/rate-limits/metrics \
  -H "Authorization: Bearer <your-admin-token>"
```

## 4. Common Customizations (1 minute)

### Add custom endpoint limit

```typescript
import { EndpointRateLimitPolicy } from './config/rate-limit-config';

const myPolicies: EndpointRateLimitPolicy[] = [
  {
    path: '/api/my-new-endpoint',
    methods: ['POST'],
    config: {
      capacity: 50,           // Burst of 50
      tokensPerInterval: 200, // 200 per minute
      refillInterval: 60_000,
    },
    keyStrategy: 'userId',
    description: 'My custom endpoint - 200 per minute with burst of 50',
  },
];

app.use(createTokenBucketRateLimitMiddleware({
  redis,
  policies: [
    ...defaultRateLimitPolicies,
    ...myPolicies,
  ],
}));
```

### Protect specific route

```typescript
import { protectWithTokenBucket } from './middleware/token-bucket-rate-limit.middleware';
import { tokenBucketPresets } from './services/token-bucket-limiter';

router.post('/api/critical-operation',
  protectWithTokenBucket(redis, tokenBucketPresets.heavyCompute()),
  handler
);
```

### Allow admins to bypass

```typescript
{
  path: '/api/users/*/delete',
  config: { ... },
  keyStrategy: 'userId',
  bypass: (context) => context.isAdmin, // Admins bypass
}
```

## Available Presets

```typescript
import { tokenBucketPresets } from './services/token-bucket-limiter';

// Sensitive operations: 5/min, burst 2
tokenBucketPresets.sensitive()

// Standard authenticated: 100/min, burst 20
tokenBucketPresets.standard()

// Public endpoints: 1000/min, burst 200
tokenBucketPresets.generous()

// Heavy compute: 10/min, burst 2
tokenBucketPresets.heavyCompute()

// Custom: build your own
tokenBucketPresets.custom(capacity, tokensPerInterval, refillInterval)
```

## Admin API Quick Reference

```bash
# View current metrics
curl -X GET http://localhost:3000/api/admin/rate-limits/metrics

# View metrics for specific date
curl -X GET http://localhost:3000/api/admin/rate-limits/metrics/2024-01-15

# View top blocked users/IPs
curl -X GET http://localhost:3000/api/admin/rate-limits/anomalies

# Get stats for endpoint
curl -X GET http://localhost:3000/api/admin/rate-limits/endpoints/POST%20%2Fapi%2Fusers/stats

# View bucket state
curl -X GET http://localhost:3000/api/admin/rate-limits/bucket/user:123

# Reset rate limit for user
curl -X POST http://localhost:3000/api/admin/rate-limits/reset/user:123

# Reset all buckets for pattern
curl -X POST http://localhost:3000/api/admin/rate-limits/reset-pattern/user:123:*

# Give user emergency quota
curl -X POST http://localhost:3000/api/admin/rate-limits/quota/allocate \
  -d '{
    "key": "user:123",
    "tokensToAdd": 500,
    "durationMs": 3600000
  }'

# Trigger cleanup
curl -X POST http://localhost:3000/api/admin/rate-limits/cleanup?daysToKeep=7
```

## Default Policies Explained

The system comes with sensible defaults:

| Endpoint | Limit | Burst | Strategy | Use Case |
|----------|-------|-------|----------|----------|
| `/auth/login` | 5/min | 2 | IP | Brute-force protection |
| `/auth/register` | 5/min | 2 | IP | Spam prevention |
| `/auth/mfa/verify` | 5/min | 2 | User | MFA attempt limiting |
| `/api/users/*` GET | 100/min | 20 | Combined | Public data retrieval |
| `/api/users/*` Write | 20/min | 10 | User | Prevent abuse |
| `/api/markets` | 1000/min | 200 | IP | Market data |
| `/api/claims/create` | 20/min | 5 | User | Trading activity |
| `/api/claims/resolve` | 10/min | 2 | User | Claim resolution |
| `/wallet/withdraw` | 2/min | 1 | User | Withdrawal protection |
| `/api/batch` | 30/min | 10 | User | Batch operations |
| `/api/admin/*` | 100/min | 50 | Combined | Admin operations |

## Troubleshooting

### Too many 429 errors?

```bash
# Check metrics
curl http://localhost:3000/api/admin/rate-limits/metrics

# See who's hitting limits
curl http://localhost:3000/api/admin/rate-limits/anomalies

# Give them quota boost
curl -X POST http://localhost:3000/api/admin/rate-limits/quota/allocate \
  -d '{"key":"user:123", "tokensToAdd":500, "durationMs":3600000}'
```

### Not getting rate limited when expected?

```bash
# Check if bypass rules apply
curl http://localhost:3000/api/admin/rate-limits/bucket/user:456

# Verify endpoint policy exists
# Check src/config/rate-limit-config.ts defaultRateLimitPolicies

# Reset and retry
curl -X POST http://localhost:3000/api/admin/rate-limits/reset/user:456
```

### Redis connection issues?

```bash
# Verify Redis is running
redis-cli ping

# Check Redis in startup logs
# Should see "redis: ok" in health check
curl http://localhost:3000/health | grep redis

# Rate limiting falls back to allowing requests if Redis fails
```

## Next Steps

1. **Monitor**: Set up alerts on denial rate spikes
2. **Tune**: Adjust limits based on real traffic patterns
3. **Test**: Run load tests to find optimal settings
4. **Document**: Add rate limits to API docs

## Full Documentation

See [RATE_LIMITING.md](./RATE_LIMITING.md) for:
- Detailed algorithm explanation
- All configuration options
- Advanced monitoring
- Production deployment
- Troubleshooting guide
