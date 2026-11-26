# Prometheus Metrics Integration Examples

This document provides practical code examples for integrating Prometheus metrics into the StellarFox platform.

## Table of Contents

1. [Backend Integration](#backend-integration)
2. [Indexer Integration](#indexer-integration)
3. [Business Metrics Recording](#business-metrics-recording)
4. [Resource Monitoring](#resource-monitoring)
5. [Custom Middleware](#custom-middleware)
6. [Database Monitoring](#database-monitoring)

---

## Backend Integration

### 1. Enabling Metrics in Main Server

**File: `backend/src/index.ts`**

```typescript
import { startResourceMetricsCollection } from './services/resourceMetrics.service';
import * as businessMetrics from './services/businessMetrics.service';

// ... existing imports ...

const app = express();

// ... existing middleware ...

// Start resource metrics collection (memory, CPU, event loop lag)
const metricsCollectionInterval = startResourceMetricsCollection(10000); // Every 10 seconds

// Periodic business metrics update (from database aggregates)
const businessMetricsInterval = setInterval(async () => {
  try {
    const stats = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM markets WHERE status = 'open') as active_count,
        (SELECT COUNT(*) FROM markets WHERE status = 'resolved') as resolved_count,
        (SELECT COUNT(*) FROM markets WHERE status = 'disputed') as disputed_count,
        (SELECT COUNT(*) FROM user_sessions WHERE last_activity > NOW() - INTERVAL '1 hour') as active_users,
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT AVG(amount_xlm) FROM bets) as avg_bet_size
    `);
    
    businessMetrics.updateBusinessMetricsSnapshot({
      activeMarketsCount: stats.rows[0].active_count,
      resolvedMarketsCount: stats.rows[0].resolved_count,
      disputedMarketsCount: stats.rows[0].disputed_count,
      activeUsersCount: stats.rows[0].active_users,
      totalUsersCount: stats.rows[0].total_users,
      averageBetSizeXlm: stats.rows[0].avg_bet_size,
    });
  } catch (err) {
    console.error('Error updating business metrics:', err);
  }
}, 60000); // Every minute

// Graceful shutdown
process.on('SIGTERM', () => {
  clearInterval(metricsCollectionInterval);
  clearInterval(businessMetricsInterval);
  // ... other cleanup ...
});

app.listen(3000, () => {
  console.log('Backend server started on port 3000');
});
```

### 2. Recording Bet Placement

**File: `backend/src/api/controllers/BetController.ts`**

```typescript
import * as businessMetrics from '../../services/businessMetrics.service';
import { recordContractInvocation, recordContractInvocationFailure } from '../../services/metrics.service';

export async function placeBet(req: Request, res: Response) {
  const { marketId, outcome, amountXlm } = req.body;
  
  try {
    // Record bet placement
    businessMetrics.recordBetPlaced(outcome, amountXlm);
    
    // Invoke contract on Stellar
    const startTime = Date.now();
    try {
      const result = await invokeContractProtected(
        'BetFactory',
        'placeBet',
        [marketId, outcome, amountXlm]
      );
      
      const latencySeconds = (Date.now() - startTime) / 1000;
      businessMetrics.recordContractInvocation('BetFactory', 'placeBet', latencySeconds);
      
      res.json({ success: true, transactionHash: result.hash });
    } catch (contractError) {
      businessMetrics.recordContractInvocationFailure(
        'BetFactory',
        'placeBet',
        contractError.name || 'unknown_error'
      );
      throw contractError;
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to place bet' });
  }
}
```

### 3. Market Resolution Tracking

**File: `backend/src/cron/autoResolution.cron.ts`**

```typescript
import * as businessMetrics from '../services/businessMetrics.service';

export async function resolveMarket(marketId: string): Promise<void> {
  const market = await db.query(
    'SELECT * FROM markets WHERE id = $1',
    [marketId]
  );
  
  if (!market.rows[0]) return;
  
  const market_data = market.rows[0];
  const lockTime = new Date(market_data.locked_at).getTime();
  const now = Date.now();
  const resolutionTime = (now - lockTime) / 1000; // Convert to seconds
  
  try {
    // Resolution logic...
    
    // Record resolution metrics
    businessMetrics.recordMarketResolutionTime(resolutionTime);
    console.log(`Market ${marketId} resolved in ${resolutionTime}s`);
  } catch (error) {
    console.error(`Failed to resolve market ${marketId}:`, error);
  }
}
```

### 4. Payout Processing

**File: `backend/src/services/PayoutService.ts`**

```typescript
import * as businessMetrics from './businessMetrics.service';

export async function processPayout(
  betId: string,
  amount: string,
  payoutAddress: string
): Promise<void> {
  try {
    // Send transaction to Stellar
    const result = await StellarService.sendPayment({
      destination: payoutAddress,
      amount: amount,
      memo: `bet-payout-${betId}`,
    });
    
    // Record successful payout
    const amountXlm = Number(amount);
    businessMetrics.recordBetPayout(amountXlm);
    console.log(`Payout processed: ${amountXlm} XLM to ${payoutAddress}`);
  } catch (error) {
    // Record payout failure
    businessMetrics.recordBetPayoutFailure();
    console.error(`Payout failed for bet ${betId}:`, error);
    throw error;
  }
}
```

### 5. User Registration Tracking

**File: `backend/src/api/controllers/AuthController.ts`**

```typescript
import * as businessMetrics from '../../services/businessMetrics.service';

export async function registerUser(req: Request, res: Response) {
  const { email, password } = req.body;
  
  try {
    // Create user in database
    const result = await db.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
      [email, await hashPassword(password)]
    );
    
    // Record user registration
    businessMetrics.recordUserRegistered();
    
    res.json({ success: true, userId: result.rows[0].id });
  } catch (error) {
    res.status(400).json({ error: 'Registration failed' });
  }
}
```

---

## Indexer Integration

### 1. Setting Up Metrics Server

**File: `indexer/src/index.ts`**

```typescript
import { createMetricsServer } from './metricsServer';
import * as metrics from './metrics';

// Start metrics HTTP server
const metricsServer = createMetricsServer({
  port: 9091,
  host: 'localhost',
});

console.log('Metrics server listening on port 9091');
console.log('  - GET /metrics - Prometheus format');
console.log('  - GET /metrics/json - JSON format');
console.log('  - GET /metrics/indexer - Custom indexer metrics');
```

### 2. Recording Event Processing

**File: `indexer/src/eventProcessing.ts`**

```typescript
import {
  recordEventSuccess,
  recordEventFailure,
  decrementQueueDepth,
  setQueueDepth,
} from './metrics';

export async function processEvent(event: BlockchainEvent): Promise<void> {
  const startTime = Date.now();
  const eventType = event.type; // 'BetPlaced', 'MarketResolved', etc.
  
  try {
    // Process the event (invoke database operations, etc.)
    await handleEvent(event);
    
    // Record success with latency
    const latencyMs = Date.now() - startTime;
    recordEventSuccess(latencyMs);
    
    // Decrement queue depth
    decrementQueueDepth();
    
    logger.info(`Event ${eventType} processed in ${latencyMs}ms`);
  } catch (error) {
    // Record failure with latency
    const latencyMs = Date.now() - startTime;
    recordEventFailure(latencyMs);
    
    // Decrement queue depth
    decrementQueueDepth();
    
    logger.error(`Event ${eventType} processing failed:`, error);
    
    // Send to DLQ for retry logic
    await sendToDLQ(event, error);
  }
}

export async function processEventBatch(events: BlockchainEvent[]): Promise<void> {
  const startTime = Date.now();
  const batchSize = events.length;
  
  try {
    // Process all events
    await Promise.all(events.map(processEvent));
    
    // Record batch success
    const latencyMs = Date.now() - startTime;
    recordBatchSuccess(latencyMs);
    
    logger.info(`Batch of ${batchSize} events processed in ${latencyMs}ms`);
  } catch (error) {
    // Record batch failure
    const latencyMs = Date.now() - startTime;
    recordBatchFailure(latencyMs);
    
    logger.error(`Batch processing failed:`, error);
  }
}
```

### 3. Queue Depth Management

**File: `indexer/src/poller.ts`**

```typescript
import { 
  setQueueDepth, 
  incrementQueueDepth,
  lastProcessedLedger,
  pollingIntervalMs,
  ledgerContinuityBreaksTotal,
} from './metrics';

export async function pollBlockchainEvents(): Promise<void> {
  while (true) {
    try {
      // Fetch new events
      const events = await fetchNewEvents();
      
      // Update queue depth with newly fetched events
      const currentDepth = await getQueueDepth();
      const newDepth = currentDepth + events.length;
      setQueueDepth(newDepth);
      
      // Update last processed ledger
      const maxLedger = events.reduce((max, e) => Math.max(max, e.ledger), 0);
      lastProcessedLedger.set(maxLedger);
      
      // Update polling interval
      pollingIntervalMs.set(CURRENT_POLLING_INTERVAL);
      
      // Add events to processing queue
      await eventQueue.enqueueMany(events);
      
      // Check for ledger continuity
      if (detectLedgerGap(events)) {
        ledgerContinuityBreaksTotal.inc();
        logger.warn('Ledger continuity break detected');
      }
      
      // Sleep before next poll
      await sleep(POLLING_INTERVAL);
    } catch (error) {
      logger.error('Polling error:', error);
      await sleep(POLLING_INTERVAL * 2); // Back off on error
    }
  }
}
```

---

## Business Metrics Recording

### 1. Market Lifecycle Tracking

**File: `backend/src/services/MarketService.ts`**

```typescript
import * as businessMetrics from './businessMetrics.service';

export async function createMarket(marketData: MarketInput): Promise<Market> {
  const market = await db.query(
    `INSERT INTO markets (title, description, status, created_at) 
     VALUES ($1, $2, $3, NOW()) RETURNING *`,
    [marketData.title, marketData.description, 'open']
  );
  
  // Record market creation
  businessMetrics.recordMarketCreated();
  
  return market.rows[0];
}

export async function lockMarket(marketId: string): Promise<void> {
  await db.query('UPDATE markets SET status = $1 WHERE id = $2', ['locked', marketId]);
  
  // Update active markets count
  const activeCount = await db.query('SELECT COUNT(*) FROM markets WHERE status = $1', ['open']);
  businessMetrics.updateActiveMarketsCount(activeCount.rows[0].count);
}
```

### 2. Revenue Tracking

**File: `backend/src/services/RevenueService.ts`**

```typescript
import { recordTransactionFee } from '../services/metrics.service';

export async function calculatePlatformFees(): Promise<void> {
  // Calculate fees from recent transactions
  const result = await db.query(`
    SELECT SUM(fee_xlm) as total_fees 
    FROM transactions 
    WHERE created_at > NOW() - INTERVAL '1 hour'
  `);
  
  const fees = result.rows[0].total_fees || 0;
  
  // Record the last transaction fee for trending
  if (fees > 0) {
    recordTransactionFee(fees);
  }
}
```

---

## Resource Monitoring

### 1. Periodic Resource Collection

**File: `backend/src/config/bootstrap.ts`**

```typescript
import { startResourceMetricsCollection } from '../services/resourceMetrics.service';
import { updateDbConnectionPoolMetrics, updateRedisConnectionPoolMetrics } from '../services/metrics.service';

export function initializeMonitoring() {
  // Start resource metrics collection every 10 seconds
  startResourceMetricsCollection(10000);
  
  // Update connection pool metrics every 30 seconds
  setInterval(() => {
    // Database pool metrics
    const dbPoolSize = pool.options.max || 20;
    const dbAvailable = pool.availableObjectsCount || 0;
    updateDbConnectionPoolMetrics(dbPoolSize, dbAvailable);
    
    // Redis pool metrics
    const redisPoolSize = redis.options?.maxRetriesPerRequest || 10;
    updateRedisConnectionPoolMetrics(redisPoolSize);
  }, 30000);
}
```

### 2. Memory Usage Thresholds

**File: `backend/src/middleware/memoryThreshold.middleware.ts`**

```typescript
import { memoryUsagePercent } from '../services/metrics.service';

export function memoryThresholdMiddleware(req: Request, res: Response, next: NextFunction) {
  // Get current memory usage
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usagePercent = ((totalMemory - freeMemory) / totalMemory) * 100;
  
  // If memory usage > 90%, reject non-critical requests
  if (usagePercent > 90) {
    if (req.path !== '/health' && req.path !== '/metrics') {
      return res.status(503).json({ error: 'Service temporarily unavailable' });
    }
  }
  
  next();
}
```

---

## Custom Middleware

### 1. Database Query Metrics Middleware

**File: `backend/src/middleware/dbMetrics.middleware.ts`**

```typescript
import { dbQueryDuration, slowDbQueriesTotal, SLOW_QUERY_THRESHOLD_MS } from '../services/metrics.service';

export function installDbMetricsListener(pool: Pool) {
  pool.on('query', (query) => {
    const startTime = Date.now();
    
    const originalCallback = query.callback;
    query.callback = (err, res) => {
      const latencyMs = Date.now() - startTime;
      const latencySeconds = latencyMs / 1000;
      
      // Determine operation type from query
      const operation = query.text.trim().split(/\s+/)[0].toLowerCase();
      
      // Record latency histogram
      dbQueryDuration.labels(operation).observe(latencySeconds);
      
      // Record slow queries
      if (latencyMs > SLOW_QUERY_THRESHOLD_MS) {
        slowDbQueriesTotal.labels(operation).inc();
        logger.warn(`Slow query (${latencyMs}ms): ${query.text.substring(0, 100)}`);
      }
      
      // Call original callback
      originalCallback(err, res);
    };
  });
}
```

### 2. Cache Hit/Miss Tracking

**File: `backend/src/services/cache.service.ts`**

```typescript
import { cacheHitsTotal, cacheMissesTotal } from './metrics.service';

export async function cacheGet(key: string): Promise<any> {
  const value = await redis.get(key);
  
  if (value) {
    cacheHitsTotal.labels(key).inc();
    return JSON.parse(value);
  } else {
    cacheMissesTotal.labels(key).inc();
    return null;
  }
}

export async function cacheSet(key: string, value: any, ttlSeconds: number = 3600): Promise<void> {
  await redis.setex(key, ttlSeconds, JSON.stringify(value));
}
```

---

## Database Monitoring

### 1. Query Performance View

**File: `backend/src/repositories/MetricsRepository.ts`**

```typescript
export async function getQueryPerformanceMetrics(): Promise<any> {
  return db.query(`
    SELECT 
      operation,
      COUNT(*) as query_count,
      AVG(latency_ms) as avg_latency,
      MAX(latency_ms) as max_latency,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) as p95_latency
    FROM query_metrics
    WHERE created_at > NOW() - INTERVAL '1 hour'
    GROUP BY operation
    ORDER BY avg_latency DESC
  `);
}
```

### 2. Connection Pool Monitoring

```typescript
export async function monitorConnectionPool(): Promise<void> {
  const stats = {
    total: pool.totalCount,
    idle: pool.idleCount,
    used: pool.totalCount - pool.idleCount,
    waiting: pool.waitingCount,
  };
  
  logger.info('Connection pool stats:', stats);
  
  // Update Prometheus metrics
  updateDbConnectionPoolMetrics(stats.total, stats.idle);
}
```

---

## Testing Metrics

### Unit Test Example

**File: `backend/tests/metrics.test.ts`**

```typescript
import * as businessMetrics from '../src/services/businessMetrics.service';
import { resetMetrics } from '../src/services/metrics.service';

describe('Business Metrics', () => {
  beforeEach(() => {
    resetMetrics();
  });
  
  test('should record bet placement', () => {
    businessMetrics.recordBetPlaced('fighter_a', 100);
    
    // Query Prometheus registry to verify metric was recorded
    const metrics = register.getMetricsAsJSON();
    const betMetric = metrics.find(m => m.name === 'bets_placed_total');
    expect(betMetric).toBeDefined();
    expect(betMetric.values[0].value).toBe(1);
  });
  
  test('should update market counts', () => {
    businessMetrics.updateBusinessMetricsSnapshot({
      activeMarketsCount: 42,
      resolvedMarketsCount: 1250,
    });
    
    const metrics = register.getMetricsAsJSON();
    const activeMarketsMetric = metrics.find(m => m.name === 'active_markets');
    expect(activeMarketsMetric.values[0].value).toBe(42);
  });
});
```

---

## Summary

These examples cover:
- ✅ Backend metrics initialization
- ✅ Business operation tracking
- ✅ Indexer event processing metrics
- ✅ Resource utilization monitoring
- ✅ Custom middleware for automatic collection
- ✅ Database performance tracking
- ✅ Testing metrics functionality

Refer to the main [PROMETHEUS_METRICS_GUIDE.md](./PROMETHEUS_METRICS_GUIDE.md) for complete metric definitions and alert configurations.
