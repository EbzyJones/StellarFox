# Prometheus Metrics Implementation Guide

This guide covers the comprehensive Prometheus metrics implementation for the StellarFox bankerchanger platform, including latency, throughput, error rates, resource utilization, and business metrics.

## Overview

The metrics implementation provides observability across:

- **API Metrics**: HTTP request latency, throughput, error rates
- **Database Metrics**: Query performance, connection pooling, slow query tracking
- **Cache Metrics**: Hit rates, Redis operations, throughput
- **Business Metrics**: Market operations, bet placement, user engagement, payouts
- **Blockchain Metrics**: Smart contract invocations, transaction costs, event processing
- **Indexer Metrics**: Event processing, batch operations, queue depth, throughput
- **Resource Metrics**: Memory usage, CPU usage, event loop lag

## Architecture

### Services

#### Backend (`/backend`)
- Main API service on port `3000`
- Metrics endpoint: `GET /metrics/export`
- Native Prometheus: port `9090` (optional)

**Key Files:**
- `src/services/metrics.service.ts` - Core Prometheus metrics definitions
- `src/services/businessMetrics.service.ts` - Business logic metrics recording
- `src/services/resourceMetrics.service.ts` - Resource utilization tracking

#### Indexer (`/indexer`)
- Blockchain event processing service
- Metrics endpoint: `GET /metrics` (port `9091`)
- Custom metrics: `GET /metrics/indexer`

**Key Files:**
- `src/metrics.ts` - Prometheus metric collectors and tracking
- `src/metricsServer.ts` - HTTP server for metrics export

### Monitoring Stack

```
┌─────────────────────────────────────────────────────────────┐
│                    Prometheus                               │
│  (Scrapes metrics every 15s from backend/indexer)          │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        │                         │
┌───────▼────────┐       ┌───────▼─────────┐
│   Grafana      │       │  AlertManager   │
│ (Dashboards)   │       │  (Alerting)     │
└────────────────┘       └─────────────────┘
```

## Metric Categories

### 1. HTTP & API Metrics

**Latency:**
- `http_request_duration_seconds` (Histogram)
  - Labels: `method`, `route`, `status_code`
  - Buckets: 10ms to 10s
  - P50, P95, P99 available via Grafana

**Throughput:**
- `http_requests_total` (Counter)
  - Labels: `method`, `route`, `status_code`
  - Use: `rate(http_requests_total[5m])` for requests/sec

**Errors:**
- `http_slow_requests_total` (Counter)
  - Tracks requests exceeding 1000ms threshold
  - Labels: `method`, `route`

### 2. Database Metrics

**Latency:**
- `db_query_duration_seconds` (Histogram)
  - Labels: `operation` (select, insert, update, delete)
  - Buckets: 1ms to 5s

**Performance:**
- `db_slow_queries_total` (Counter)
  - Queries exceeding 500ms threshold
- `db_connection_pool_size` (Gauge)
  - Total connections in pool
- `db_connection_pool_available` (Gauge)
  - Available connections

### 3. Cache & Redis Metrics

**Hit Rate:**
- `cache_hits_total` (Counter) - By cache key
- `cache_misses_total` (Counter) - By cache key

**Operations:**
- `redis_operation_duration_seconds` (Histogram)
  - Labels: `operation`
  - Buckets: 1ms to 500ms
- `redis_connection_pool_size` (Gauge)

### 4. WebSocket Metrics

- `websocket_active_connections` (Gauge)
- `websocket_messages_sent_total` (Counter) - By message type
- `websocket_messages_received_total` (Counter) - By message type

### 5. Business Metrics

**Markets:**
- `markets_created_total` (Counter)
- `active_markets` (Gauge)
- `resolved_markets` (Gauge)
- `disputed_markets` (Gauge)
- `market_resolution_latency_seconds` (Histogram)

**Bets:**
- `bets_placed_total` (Counter) - By outcome
- `total_wagered_xlm` (Gauge)
- `average_bet_size_xlm` (Gauge)
- `bet_payouts_total` (Counter)
- `bet_payout_failures_total` (Counter)
- `total_paid_out_xlm` (Gauge)

**Users:**
- `users_registered_total` (Counter)
- `active_users` (Gauge)
- `total_users` (Gauge)
- `user_auth_failures_total` (Counter) - By reason

### 6. Blockchain Metrics

**Smart Contracts:**
- `contract_invocations_total` (Counter)
  - Labels: `contract`, `operation`
- `contract_invocation_failures_total` (Counter)
  - Labels: `contract`, `operation`, `error_type`
- `contract_invocation_latency_seconds` (Histogram)
  - Labels: `contract`, `operation`
  - Buckets: 500ms to 30s

**Transactions:**
- `transaction_fee_cost_xlm` (Gauge)

### 7. Indexer Metrics

**Event Processing:**
- `indexer_events_processed_success_total` (Counter)
- `indexer_events_processed_failure_total` (Counter)
- `indexer_event_processing_latency_ms` (Histogram)

**Batch Processing:**
- `indexer_batches_processed_success_total` (Counter)
- `indexer_batches_processed_failure_total` (Counter)
- `indexer_batch_processing_latency_ms` (Histogram)

**Queue & Throughput:**
- `indexer_queue_depth` (Gauge)
- `indexer_throughput_events_per_second` (Gauge)
- `indexer_throughput_batches_per_minute` (Gauge)

### 8. Resource Utilization Metrics

- `memory_usage_percent` (Gauge) - System memory %
- `cpu_usage_percent` (Gauge) - CPU usage %
- `event_loop_lag_ms` (Gauge) - Node.js event loop lag

### 9. Error Metrics

- `application_errors_total` (Counter) - By error type and route
- `database_errors_total` (Counter) - By error type
- `external_service_errors_total` (Counter) - By service

## Recording Metrics

Pre-computed aggregations (see `rules/recording-rules-updated.yml`):

```
http:requests:rate5m                  - Requests per second
http:request_duration:p95             - P95 latency
db:query_duration:p99                 - P99 DB latency
cache:hit_rate:5m                     - Cache hit rate percentage
business:bets:rate5m                  - Bets per second
business:payouts:failure_rate5m       - Payout failure rate
blockchain:contract_latency:p95       - P95 contract latency
indexer:events:error_rate1m           - Indexer event error rate
errors:application:rate5m             - App errors per second
```

## Alert Rules

Critical alerts configured in `rules/alerts-updated.yml`:

### By Severity

**Critical:**
- Service down (up == 0)
- High HTTP error rate (> 5%)
- Database connection pool exhausted (< 10% available)
- Bet payout failures (> 10 in 5m)
- Contract invocation failure rate (> 5%)
- Ledger continuity breaks (> 3 in 1h)
- Indexer queue backlog (> 5000 events)
- Critical memory usage (> 95%)

**Warning:**
- Slow HTTP requests (> 10% of requests)
- Slow DB queries (> 10 per second)
- Low cache hit rate (< 60%)
- High request latency (P95 > 2s)
- High DB query latency (P99 > 1s)
- Market resolution delays (P95 > 5m)
- Low bet activity (0 bets in 1h)
- High auth failure rate (> 100 in 5m)
- High CPU usage (> 80%)
- High memory usage (> 85%)
- Event loop lag (> 100ms)

## Usage in Code

### Recording Business Metrics

```typescript
import * as businessMetrics from './services/businessMetrics.service';

// Record a market creation
businessMetrics.recordMarketCreated();

// Record a bet
businessMetrics.recordBetPlaced('fighter_a', 100.5);

// Record a payout
businessMetrics.recordBetPayout(250.75);

// Update status gauges (typically from periodic queries)
businessMetrics.updateBusinessMetricsSnapshot({
  activeMarketsCount: 42,
  resolvedMarketsCount: 1250,
  disputedMarketsCount: 3,
  activeUsersCount: 892,
  totalUsersCount: 5420,
  averageBetSizeXlm: 45.3,
});
```

### Recording Contract Operations

```typescript
import { recordContractInvocation, recordContractInvocationFailure } from './services/metrics.service';

const startTime = Date.now();
try {
  // Invoke contract
  await contract.placeB bet(params);
  
  const latencySeconds = (Date.now() - startTime) / 1000;
  recordContractInvocation('BetFactory', 'placeBet', latencySeconds);
} catch (error) {
  recordContractInvocationFailure('BetFactory', 'placeBet', 'timeout');
}
```

### Recording Indexer Metrics

```typescript
import { recordEventSuccess, recordEventFailure, setQueueDepth } from '../metrics';

const startTime = Date.now();
try {
  // Process event
  await processBlockchainEvent(event);
  
  const latencyMs = Date.now() - startTime;
  recordEventSuccess(latencyMs);
  
  // Update queue depth after processing
  setQueueDepth(remainingEventCount);
} catch (error) {
  recordEventFailure(Date.now() - startTime);
}
```

### Resource Metrics Collection

```typescript
import { startResourceMetricsCollection } from './services/resourceMetrics.service';

// Start collecting resource metrics every 10 seconds
const intervalId = startResourceMetricsCollection(10000);

// Later, stop collection
clearInterval(intervalId);
```

## Configuration

### Environment Variables

```bash
# Backend
METRICS_ENABLED=true
METRICS_PORT=9090
SLOW_REQUEST_THRESHOLD_MS=1000
SLOW_QUERY_THRESHOLD_MS=500

# Indexer
METRICS_PORT=9091
```

### Prometheus Configuration

See `monitoring/prometheus/prometheus-updated.yml`:

```yaml
scrape_configs:
  - job_name: 'bankerchanger-backend'
    static_configs:
      - targets: ['backend:9090']
    scrape_interval: 15s

  - job_name: 'bankerchanger-indexer'
    static_configs:
      - targets: ['indexer:9091']
    scrape_interval: 10s
```

## Grafana Dashboards

Key dashboard panels:

### Request Performance
- Request rate (by route)
- P50, P95, P99 latency
- Error rate trend
- Slow request rate

### Database Health
- Query rate by operation
- P95 query latency
- Connection pool utilization
- Slow query rate

### Business KPIs
- Markets created (counter)
- Active markets (gauge)
- Bets placed per minute
- Total wagered (XLM)
- Payout success rate
- Average bet size

### Blockchain Operations
- Contract invocation rate
- Contract failure rate
- Transaction fee costs
- Event processing latency

### Indexer Health
- Event processing rate
- Event error rate
- Queue depth
- Throughput (events/sec, batches/min)

### System Resources
- Memory usage %
- CPU usage %
- Event loop lag
- Connection pool sizes

## Best Practices

### 1. Labeling
- Use consistent label names across metrics
- Limit cardinality (avoid high-cardinality labels like user IDs)
- Use lowercase for label values

### 2. Recording Rules
- Pre-aggregate common queries for dashboard performance
- Compute percentiles at record time, not query time
- Keep recording rule intervals aligned with scrape intervals

### 3. Alerting
- Set appropriate thresholds based on SLOs
- Use `for` clauses to avoid alert flapping
- Include actionable information in annotations

### 4. Data Retention
- Keep high-resolution data for 15 days
- Downsample to 5-minute resolution for 90 days
- Configure via Prometheus `retention` setting

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
  external_labels:
    cluster: 'production'
```

### 5. Cost Optimization
- Sample metrics for high-volume endpoints (use `sampling_ratio` in histogram buckets)
- Aggregate similar operations into single metrics
- Use Prometheus remote storage for long-term retention

## Troubleshooting

### High Cardinality Issues
Check metrics with many label combinations:

```
count(count by (labels) (metric)) > 10000
```

### Missing Metrics
Verify endpoints are reachable:

```bash
curl http://backend:9090/metrics
curl http://indexer:9091/metrics
```

### Scrape Failures
Check Prometheus targets page: `http://prometheus:9090/targets`

### High Memory Usage
- Reduce scrape frequency
- Increase metric retention time for older data
- Use recording rules to reduce query complexity

## Next Steps

1. Import Grafana dashboards from `monitoring/grafana/dashboards/`
2. Configure AlertManager in `monitoring/alertmanager/alertmanager.yml`
3. Set up notification channels (email, Slack, PagerDuty)
4. Create runbooks for common alerts
5. Monitor metric cardinality and optimize as needed

## References

- [Prometheus Documentation](https://prometheus.io/docs/)
- [prom-client Library](https://github.com/siimon/prom-client)
- [Prometheus Best Practices](https://prometheus.io/docs/practices/naming/)
- [SRE Golden Signals](https://sre.google/sre-book/monitoring-distributed-systems/)
