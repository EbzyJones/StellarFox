# Rate Limiting Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Client Requests                             │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
        ┌──────────────────────────────────────────┐
        │  Express Application                     │
        │  ┌────────────────────────────────────┐  │
        │  │ Token Bucket Rate Limit Middleware │  │
        │  └────────────────┬───────────────────┘  │
        │                   │                       │
        └───────────────────┼───────────────────────┘
                            │
                ┌───────────┼───────────┐
                │           │           │
                ▼           ▼           ▼
        ┌──────────────┐  ┌──────────────┐
        │  Policy      │  │  Rate Limit  │
        │  Matching    │  │  Config      │
        │              │  │              │
        └──────────────┘  └──────────────┘
                │
                ▼
        ┌──────────────────────────────────────┐
        │ Token Bucket Limiter Service         │
        │                                       │
        │ - consume(key, tokens)               │
        │ - reset(key)                         │
        │ - getState(key)                      │
        │ - addTokens(key, tokens)             │
        └──────────────────────────────────────┘
                │
                ▼
        ┌──────────────────────────────────────┐
        │ Redis Connection                     │
        │                                       │
        │ [Lua Script Execution]               │
        │ Atomic Operations                    │
        └──────────────────────────────────────┘
                │
                ▼
        ┌──────────────────────────────────────┐
        │ Redis Storage                        │
        │                                       │
        │ HASH: token-bucket:key               │
        │   - last_refill: Unix timestamp      │
        │   - tokens: Current tokens           │
        └──────────────────────────────────────┘

Parallel Tracking:
        │
        ├─→ Rate Limit Monitor
        │   - Track metrics
        │   - Detect anomalies
        │   - Manage quotas
        │
        └─→ Admin API
            - View metrics
            - Reset buckets
            - Allocate quota
            - Manage policies
```

## Request Flow

```
Request arrives
        │
        ▼
┌─────────────────────────────────────────┐
│ Build Rate Limit Context                │
│ - Method: POST                          │
│ - Path: /api/users                      │
│ - IP: 192.168.1.1                       │
│ - User ID: user:123                     │
└──────────┬──────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│ Find Matching Policy                    │
│ (from rate-limit-config.ts)             │
│                                         │
│ Matching path: /api/users/*             │
│ Method: POST                            │
│ Key strategy: userId                    │
│ Config: 20 tokens/min, burst 10         │
└──────────┬──────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│ Generate Rate Limit Key                 │
│                                         │
│ Key = "user:123"                        │
└──────────┬──────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│ Execute Lua Script in Redis             │
│                                         │
│ 1. Get current bucket state             │
│ 2. Calculate refilled tokens            │
│ 3. Check if tokens available            │
│ 4. Update bucket if allowed             │
│ 5. Return: allowed, remaining, resetAt  │
└──────────┬──────────────────────────────┘
           │
        ┌──┴──┐
        │     │
        ▼     ▼
      ALLOW DENY
        │     │
        ▼     ▼
    Continue 429 Error
        │
        └──→ Set Response Headers
            - RateLimit-Remaining
            - Retry-After
            - X-RateLimit-*
```

## Redis Data Model

### Single Bucket Storage
```
Redis Key: token-bucket:user:123

HGETALL token-bucket:user:123
{
  "last_refill": 1700000000000  // Unix timestamp (ms)
  "tokens": 15                   // Current tokens available
}

TTL: 3660000 ms (1 hour + margin)
```

### Metrics Storage
```
Redis Keys: rate-limit-metrics:*

Daily aggregation:
- rate-limit-metrics:total:2024-01-15      → 5000 (total requests)
- rate-limit-metrics:denied:2024-01-15     → 50 (denied requests)
- rate-limit-metrics:success:2024-01-15    → 4950 (allowed requests)

Hourly breakdown:
- rate-limit-metrics:success:hour:2024-01-15-14  → 400
- rate-limit-metrics:denied:hour:2024-01-15-14   → 5

Endpoint tracking:
- rate-limit-metrics:endpoint:POST /api/users:2024-01-15      → 300
- rate-limit-metrics:endpoint:POST /api/users:denied:2024-01-15 → 2

Anomaly detection:
- rate-limit-metrics:anomalies:2024-01-15  (ZSET)
  → user:456  (score: 150 denials)
  → user:789  (score: 85 denials)
```

## Lua Script Architecture

### Token Bucket Script Flow
```
Redis.eval(TOKEN_BUCKET_SCRIPT, 1,
  KEYS[1]: "token-bucket:user:123"
  ARGV[1]: now (current time)
  ARGV[2]: 100 (capacity)
  ARGV[3]: 100 (tokens per interval)
  ARGV[4]: 60000 (refill interval ms)
  ARGV[5]: 1 (tokens requested)
)

Inside Lua:
  1. Get bucket state: [last_refill, tokens]
  2. Calculate elapsed = now - last_refill
  3. Calculate refills = floor(elapsed / interval)
  4. Add refilled tokens (min capacity)
  5. Check if tokens >= requested
  6. Update bucket (atomic)
  7. Calculate next reset time
  8. Return [allowed, remaining, resetAt, retryAfter]

All operations atomic - no race conditions
```

## Multi-Instance Synchronization

```
Backend Instance 1              Backend Instance 2
      │                                 │
      └────────────┬────────────────────┘
                   │
              ┌────▼─────┐
              │  Redis   │  Single Source of Truth
              │          │
              │ Bucket   │
              │ user:123 │
              │          │
              └──────────┘

Request from Instance 1:
  Lua script increments counter atomically
  
Request from Instance 2 (same second):
  Lua script reads updated value
  Both instances stay in sync automatically
  
No distributed locking needed
Atomic Lua scripting ensures consistency
```

## Configuration Hierarchy

```
┌────────────────────────────────────────────┐
│ Application (src/index.ts)                 │
│                                            │
│ createTokenBucketRateLimitMiddleware({     │
│   redis,                                   │
│   policies: [array of policies],           │
│   defaultConfig: {...},                    │
│   enableDetailedHeaders: true              │
│ })                                         │
└────────────────────────────────────────────┘
            │
            ▼
┌────────────────────────────────────────────┐
│ Per-Route Policies                         │
│ (src/config/rate-limit-config.ts)          │
│                                            │
│ [                                          │
│   {                                        │
│     path: "/api/users/*"                   │
│     methods: ["POST"]                      │
│     keyStrategy: "userId"                  │
│     config: {                              │
│       capacity: 10                         │
│       tokensPerInterval: 20                │
│       refillInterval: 60_000               │
│     }                                      │
│     bypass: (context) => {...}             │
│   },                                       │
│   ...                                      │
│ ]                                          │
└────────────────────────────────────────────┘
            │
            ▼
┌────────────────────────────────────────────┐
│ Request-Time Decision                      │
│                                            │
│ 1. Match path against policies             │
│ 2. Apply bypass rules                      │
│ 3. Generate key                            │
│ 4. Check Redis bucket                      │
│ 5. Return allow/deny                       │
└────────────────────────────────────────────┘
```

## Admin API Architecture

```
Admin Request to /api/admin/rate-limits/metrics
        │
        ▼
┌─────────────────────────────────────────┐
│ Require Admin Middleware                │
│ Verify authentication                   │
└──────────┬──────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│ RateLimitMonitor Service                │
│                                         │
│ - Query Redis metrics keys              │
│ - Aggregate data                        │
│ - Calculate rates                       │
│ - Detect top blocked entities           │
└──────────┬──────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────┐
│ Return JSON Response                    │
│                                         │
│ {                                       │
│   totalRequests: 50000                  │
│   deniedRequests: 1200                  │
│   denialRate: 0.024                     │
│   topBlockedUsers: [...]                │
│   topBlockedIps: [...]                  │
│ }                                       │
└─────────────────────────────────────────┘
```

## Error Handling & Fallback

```
Request Processing
        │
        ▼
Try: Get rate limit from Redis
        │
        ├─ Success ──→ Apply limit ──→ Continue
        │
        └─ Error (Redis down)
                │
                ▼
            Log error
                │
                ▼
            Check fallback policy
                │
                ├─ Allow all (default) ──→ Continue
                └─ Other policy      ──→ Apply locally
```

## Monitoring Dashboard Flow

```
Admin queries /api/admin/rate-limits/metrics
        │
        ▼
Check Redis keys for today
        │
        ├─→ rate-limit-metrics:total:DATE
        ├─→ rate-limit-metrics:denied:DATE
        ├─→ rate-limit-metrics:key:*:denied:DATE
        ├─→ rate-limit-metrics:anomalies:DATE
        └─→ rate-limit-metrics:retry-after:DATE
        │
        ▼
Aggregate into response:
        │
        ├─ Total requests
        ├─ Denied requests
        ├─ Denial rate (%)
        ├─ Top blocked users
        ├─ Top blocked IPs
        └─ Detected anomalies
        │
        ▼
Return JSON with:
        │
        ├─ Current metrics
        ├─ Top offenders
        ├─ Alert conditions
        └─ Trend data
```

## Token Refill Mechanics

```
Bucket Creation (time 0ms):
┌──────────────────────┐
│ Capacity: 20         │
│ Current: 20          │  Full bucket
└──────────────────────┘

After 10 requests (time 100ms):
┌──────────────────────┐
│ Capacity: 20         │
│ Current: 10          │  10 tokens remain
└──────────────────────┘

Automatic refill (time 30,000ms = 30 seconds):
┌──────────────────────┐
│ Capacity: 20         │
│ Current: 15          │  Refilled with 100 tokens/min = 50 tokens over 30s
│ (capped at capacity) │  Excess tokens discarded
└──────────────────────┘

After 15 more requests (time 30,100ms):
┌──────────────────────┐
│ Capacity: 20         │
│ Current: 0           │  Empty bucket
└──────────────────────┘

Request denied until refill at time 60,000ms
```

## Performance Characteristics

```
Request Latency Distribution:
        │ Request count
        │
   100% │
        │      ╱─────╲
   75%  │     ╱       ╲
        │    ╱         ╲
   50%  │   ╱           ╲
        │  ╱             ╲
   25%  │ ╱               ╲
        │                  ╲
        └──────────────────┬──────── Latency (ms)
                 1-2ms  5-10ms

Typical: 2-5ms per request
95th percentile: <10ms
99th percentile: <20ms
(measured on single Redis instance)
```

## Scaling Scenarios

### Single Instance
```
Backend ──→ Redis ✓
Suitable for: Dev, testing, single-region
Latency: 1-2ms
```

### Multi-Region
```
Backend 1 ┐
Backend 2 ├─→ Redis (central) ✓
Backend 3 ┘
Suitable for: Production, multi-region
Latency: 1-5ms (depends on geography)
```

### Redis Cluster
```
Backend 1 ┐
Backend 2 ├─→ Redis Cluster ✓
Backend 3 ┘
Suitable for: High-throughput, millions of buckets
Latency: 1-3ms
Throughput: 100K+ requests/second
```

This architecture ensures:
✓ Consistency across all instances
✓ No single point of failure (Redis Sentinel/Cluster)
✓ Horizontal scalability
✓ Sub-10ms latency
✓ Atomic operations (no race conditions)
