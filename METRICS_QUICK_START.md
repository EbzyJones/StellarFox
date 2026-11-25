# Prometheus Metrics Quick Start

Get Prometheus metrics running in 10 minutes.

## 1. Backend Setup (5 mins)

### Enable metrics collection in your code:

```typescript
// In backend/src/index.ts
import { startResourceMetricsCollection } from './services/resourceMetrics.service';
import * as businessMetrics from './services/businessMetrics.service';

// Start collecting resource metrics every 10 seconds
startResourceMetricsCollection(10000);

// Update business metrics every minute
setInterval(async () => {
  const stats = await fetchBusinessStats(); // Your DB query
  businessMetrics.updateBusinessMetricsSnapshot(stats);
}, 60000);
```

### Record business operations:

```typescript
// When a user places a bet
import * as businessMetrics from './services/businessMetrics.service';
businessMetrics.recordBetPlaced('fighter_a', 100.5);

// When a market is resolved
businessMetrics.recordMarketResolutionTime(resolutionSeconds);

// When a payout succeeds
businessMetrics.recordBetPayout(payoutAmount);
```

**Metrics available at:**
- `GET /metrics/export` - JSON format
- `GET http://backend:9090/metrics` - Prometheus format (if native endpoint enabled)

## 2. Indexer Setup (3 mins)

### Enable metrics server:

```typescript
// In indexer/src/index.ts
import { createMetricsServer } from './metricsServer';

// Start metrics server on port 9091
createMetricsServer({ port: 9091 });
```

### Record event processing:

```typescript
import { recordEventSuccess, recordEventFailure, setQueueDepth } from './metrics';

// In your event processing loop
try {
  await processEvent(event);
  recordEventSuccess(latencyMs);
  decrementQueueDepth();
} catch (error) {
  recordEventFailure(latencyMs);
}
```

**Metrics available at:**
- `GET http://indexer:9091/metrics` - Prometheus format
- `GET http://indexer:9091/metrics/json` - JSON format

## 3. Configure Prometheus (2 mins)

Create/update `monitoring/prometheus/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'bankerchanger-backend'
    static_configs:
      - targets: ['backend:9090']

  - job_name: 'bankerchanger-indexer'
    static_configs:
      - targets: ['indexer:9091']
```

## 4. Run the Stack

```bash
# Start Prometheus
docker-compose -f docker-compose.monitoring.yml up -d prometheus

# Verify metrics are being scraped
# Visit: http://localhost:9090/targets
```

## Key Metrics to Monitor

### Request Performance
```promql
# Request rate (per second)
rate(http_requests_total[5m])

# Error rate
rate(http_requests_total{status_code=~"5.."}[5m])

# P95 latency
histogram_quantile(0.95, http_request_duration_seconds_bucket)
```

### Business KPIs
```promql
# Bets per minute
rate(bets_placed_total[1m])

# Total wagered
increase(total_wagered_xlm[1h])

# Payout failure rate
rate(bet_payout_failures_total[5m]) / (rate(bet_payouts_total[5m]) + rate(bet_payout_failures_total[5m]))
```

### System Health
```promql
# Memory usage
memory_usage_percent

# CPU usage
cpu_usage_percent

# Event loop lag
event_loop_lag_ms

# DB connection pool utilization
(db_connection_pool_size - db_connection_pool_available) / db_connection_pool_size
```

### Indexer Health
```promql
# Event processing rate
rate(indexer_events_processed_success_total[1m])

# Event error rate
rate(indexer_events_processed_failure_total[1m])

# Queue depth
indexer_queue_depth

# Event processing latency (p95)
histogram_quantile(0.95, indexer_event_processing_latency_ms_bucket)
```

## Create Your First Dashboard

1. Open Grafana: `http://localhost:3000`
2. Create new dashboard
3. Add panel with queries from above
4. Example panel: Request rate + error rate combo chart

## Common Queries

### Top 5 Slowest Endpoints
```promql
topk(5, http_request_duration_seconds_bucket)
```

### Most Common Errors
```promql
topk(5, increase(http_requests_total{status_code=~"5.."}[1h]))
```

### Cache Hit Rate
```promql
sum(rate(cache_hits_total[5m])) / (sum(rate(cache_hits_total[5m])) + sum(rate(cache_misses_total[5m])))
```

### Market Resolution Time Trend
```promql
histogram_quantile(0.95, market_resolution_latency_seconds_bucket)
```

## Troubleshooting

### No metrics showing?

1. Check endpoints are accessible:
   ```bash
   curl http://localhost:9090/metrics     # Backend
   curl http://localhost:9091/metrics     # Indexer
   ```

2. Check Prometheus targets:
   ```bash
   curl http://localhost:9090/api/v1/targets
   ```

3. Verify scrape config is correct in Prometheus

### High cardinality issues?

Avoid labeling by user ID or similar:
```typescript
// ❌ BAD - creates high cardinality
betMetric.labels(userId, outcome).inc();

// ✅ GOOD - limited label values
betMetric.labels(outcome).inc();
```

### Memory usage high?

- Reduce scrape interval (not faster than 15s)
- Increase metric retention period
- Use recording rules to pre-aggregate

## Next Steps

1. Set up Grafana dashboards
2. Configure alerting rules
3. Integrate with alertmanager (Slack, PagerDuty, etc.)
4. Create runbooks for alerts
5. Monitor metric cardinality

## Documentation

- [Full Metrics Guide](./PROMETHEUS_METRICS_GUIDE.md)
- [Integration Examples](./METRICS_INTEGRATION_EXAMPLES.md)
- [Prometheus Docs](https://prometheus.io/docs/)

## Common Commands

```bash
# Check if Prometheus is scraping correctly
curl http://prometheus:9090/api/v1/query?query=up

# Get all metrics available
curl http://prometheus:9090/api/v1/label/__name__/values

# Query time range
curl 'http://prometheus:9090/api/v1/query_range?query=rate(requests_total[5m])&start=1609459200&end=1609462800&step=60'

# Check targets
curl http://prometheus:9090/api/v1/targets
```
