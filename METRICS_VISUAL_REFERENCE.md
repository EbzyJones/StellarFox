# Prometheus Metrics Visual Reference

## Metrics Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                      StellarFox Backend                            │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐ │
│  │   Controllers    │  │   Services       │  │   Database       │ │
│  │                  │  │                  │  │                  │ │
│  │ - Auth           │  │ - BetService     │  │ Queries tracked  │ │
│  │ - Bet            │  │ - MarketService  │  │ Latency measured │ │
│  │ - Market         │  │ - PayoutService  │  │ Pools monitored  │ │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘ │
│           │                     │                     │            │
│           └─────────────┬───────┴─────────────┬───────┘            │
│                         │                     │                    │
│         ┌───────────────▼──────────┬──────────▼─────────┐          │
│         │  Metrics Service (prom-  │                    │          │
│         │  client library)         │                    │          │
│         │                          │                    │          │
│         │  40+ Prometheus Metrics: │                    │          │
│         │  • HTTP requests         │  Endpoints:        │          │
│         │  • DB queries            │  • /metrics/export │          │
│         │  • Cache ops             │  • /metrics (9090) │          │
│         │  • Contract calls        │                    │          │
│         │  • Business events       │                    │          │
│         │  • Resource usage        │                    │          │
│         └────────────────┬─────────┴──────────┬─────────┘          │
│                          │                    │                    │
│         ┌────────────────▼────────────────────▼──────────┐         │
│         │   Resource Metrics Collector                   │         │
│         │   (every 10 seconds)                           │         │
│         │                                                │         │
│         │  • Memory % usage                              │         │
│         │  • CPU % usage                                 │         │
│         │  • Event loop lag                              │         │
│         │  • Connection pools                            │         │
│         └────────────────┬─────────────────────┬─────────┘         │
│                          │                     │                   │
│         ┌────────────────▼─────────────────────▼──────────┐        │
│         │   Business Metrics Updater                      │        │
│         │   (every 60 seconds)                            │        │
│         │                                                 │        │
│         │  • Market stats (active, resolved)              │        │
│         │  • User stats (registered, active)              │        │
│         │  • Bet stats (placed, wagered, payouts)         │        │
│         └────────────────┬─────────────────────┬──────────┘        │
│                          │                     │                   │
└──────────────────────────┼─────────────────────┼───────────────────┘
                           │                     │
                    ┌──────▼─────────┐  ┌───────▼──────┐
                    │  Prometheus    │  │   Grafana    │
                    │  (Scrapes      │  │   (Display)  │
                    │   every 15s)   │  │              │
                    └────────────────┘  └──────────────┘
```

## Indexer Metrics Flow

```
┌───────────────────────────────────────────────────────────────┐
│                   StellarFox Indexer                          │
│                                                               │
│  ┌──────────────────────────────────┐                         │
│  │  Blockchain Event Poller         │                         │
│  │  Fetches from Stellar RPC        │                         │
│  └────────────────┬─────────────────┘                         │
│                   │                                           │
│                   ▼                                           │
│  ┌──────────────────────────────────┐                         │
│  │  Event Queue                     │◄─── Queue Depth Gauge   │
│  │  (pending events)                │                         │
│  └────────────────┬─────────────────┘                         │
│                   │                                           │
│                   ▼                                           │
│  ┌──────────────────────────────────────────┐                 │
│  │  Event Batch Processor                   │                 │
│  │                                          │                 │
│  │  For each event:                         │                 │
│  │  - recordEventSuccess() or recordFailure()                │
│  │  - Measure latency (ms)                  │                 │
│  │  - Update queue depth                    │                 │
│  │                                          │                 │
│  │  For each batch:                         │                 │
│  │  - recordBatchSuccess() or recordFailure()                │
│  │  - Calculate batch latency               │                 │
│  │  - Calculate throughput (events/sec)     │                 │
│  └────────────────┬─────────────────────────┘                 │
│                   │                                           │
│                   ▼                                           │
│  ┌──────────────────────────────────────────┐                 │
│  │  Metrics Tracking (prom-client)          │                 │
│  │                                          │                 │
│  │  Counters:                               │                 │
│  │  • events_processed_success_total        │                 │
│  │  • events_processed_failure_total        │                 │
│  │  • batches_processed_success_total       │                 │
│  │  • batches_processed_failure_total       │                 │
│  │                                          │                 │
│  │  Histograms:                             │                 │
│  │  • event_processing_latency_ms           │                 │
│  │  • batch_processing_latency_ms           │                 │
│  │                                          │                 │
│  │  Gauges:                                 │                 │
│  │  • queue_depth                           │                 │
│  │  • throughput_events_per_sec             │                 │
│  │  • throughput_batches_per_min            │                 │
│  │  • last_processed_ledger_sequence        │                 │
│  │  • polling_interval_ms                   │                 │
│  └────────────────┬─────────────────────────┘                 │
│                   │                                           │
│                   ▼                                           │
│  ┌──────────────────────────────────┐                         │
│  │  Metrics Server (Express)        │                         │
│  │                                  │                         │
│  │  GET /metrics                    │◄─── Prometheus format   │
│  │  GET /metrics/json               │◄─── JSON format         │
│  │  GET /metrics/indexer            │◄─── Custom metrics      │
│  │  GET /health                     │◄─── Health check        │
│  └──────────────────────────────────┘                         │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

## Metric Hierarchy

```
Prometheus Metrics
│
├── HTTP & API Metrics
│   ├── http_request_duration_seconds (Histogram)
│   │   └── Labels: method, route, status_code
│   │   └── Buckets: 10ms to 10s
│   │
│   ├── http_requests_total (Counter)
│   │   └── Labels: method, route, status_code
│   │
│   └── http_slow_requests_total (Counter)
│       └── Labels: method, route
│
├── Database Metrics
│   ├── db_query_duration_seconds (Histogram)
│   │   └── Labels: operation
│   │
│   ├── db_slow_queries_total (Counter)
│   │   └── Labels: operation
│   │
│   ├── db_connection_pool_size (Gauge)
│   │
│   └── db_connection_pool_available (Gauge)
│
├── Cache & Redis Metrics
│   ├── cache_hits_total (Counter)
│   │   └── Labels: cache_key
│   │
│   ├── cache_misses_total (Counter)
│   │   └── Labels: cache_key
│   │
│   ├── redis_operation_duration_seconds (Histogram)
│   │   └── Labels: operation
│   │
│   └── redis_connection_pool_size (Gauge)
│
├── Business Metrics
│   ├── Markets
│   │   ├── markets_created_total (Counter)
│   │   ├── active_markets (Gauge)
│   │   ├── resolved_markets (Gauge)
│   │   ├── disputed_markets (Gauge)
│   │   └── market_resolution_latency_seconds (Histogram)
│   │
│   ├── Bets
│   │   ├── bets_placed_total (Counter) - by outcome
│   │   ├── total_wagered_xlm (Gauge)
│   │   ├── average_bet_size_xlm (Gauge)
│   │   ├── bet_payouts_total (Counter)
│   │   ├── bet_payout_failures_total (Counter)
│   │   └── total_paid_out_xlm (Gauge)
│   │
│   └── Users
│       ├── users_registered_total (Counter)
│       ├── active_users (Gauge)
│       ├── total_users (Gauge)
│       └── user_auth_failures_total (Counter) - by reason
│
├── Blockchain Metrics
│   ├── contract_invocations_total (Counter)
│   │   └── Labels: contract, operation
│   │
│   ├── contract_invocation_failures_total (Counter)
│   │   └── Labels: contract, operation, error_type
│   │
│   ├── contract_invocation_latency_seconds (Histogram)
│   │   └── Labels: contract, operation
│   │
│   ├── blockchain_events_processed_total (Counter)
│   │   └── Labels: event_type, status
│   │
│   ├── blockchain_event_processing_latency_seconds (Histogram)
│   │   └── Labels: event_type
│   │
│   ├── blockchain_event_queue_depth (Gauge)
│   │
│   ├── last_processed_ledger_sequence (Gauge)
│   │
│   └── transaction_fee_cost_xlm (Gauge)
│
├── Indexer Metrics
│   ├── indexer_events_processed_success_total (Counter)
│   ├── indexer_events_processed_failure_total (Counter)
│   ├── indexer_event_processing_latency_ms (Histogram)
│   ├── indexer_batches_processed_success_total (Counter)
│   ├── indexer_batches_processed_failure_total (Counter)
│   ├── indexer_batch_processing_latency_ms (Histogram)
│   ├── indexer_queue_depth (Gauge)
│   ├── indexer_throughput_events_per_second (Gauge)
│   └── indexer_throughput_batches_per_minute (Gauge)
│
├── Resource Utilization Metrics
│   ├── memory_usage_percent (Gauge)
│   ├── cpu_usage_percent (Gauge)
│   ├── event_loop_lag_ms (Gauge)
│   ├── websocket_active_connections (Gauge)
│   └── Node.js default metrics (from prom-client)
│       ├── process_cpu_seconds_total
│       ├── process_resident_memory_bytes
│       ├── nodejs_eventloop_lag_seconds
│       ├── nodejs_gc_duration_seconds
│       └── ...
│
└── Error Metrics
    ├── application_errors_total (Counter)
    │   └── Labels: error_type, route
    │
    ├── database_errors_total (Counter)
    │   └── Labels: error_type
    │
    └── external_service_errors_total (Counter)
        └── Labels: service
```

## Alert Rule Hierarchy

```
Prometheus Alert Rules
│
├── HTTP & API Alerts (3 rules)
│   ├── HighHttpErrorRate (critical)
│   ├── SlowHttpRequests (warning)
│   └── HttpRequestLatencyHigh (warning)
│
├── Database Alerts (3 rules)
│   ├── SlowDatabaseQueries (warning)
│   ├── DatabaseQueryLatencyHigh (warning)
│   └── DatabaseConnectionPoolExhausted (critical)
│
├── Cache Alerts (2 rules)
│   ├── LowCacheHitRate (warning)
│   └── RedisOperationLatencyHigh (warning)
│
├── Business Alerts (3 rules)
│   ├── MarketResolutionDelayed (warning)
│   ├── BetPayoutFailuresIncreasing (critical)
│   └── LowBetActivity (warning)
│
├── Blockchain Alerts (4 rules)
│   ├── ContractInvocationFailureRate (critical)
│   ├── ContractInvocationLatencyHigh (warning)
│   ├── LedgerContinuityBreaks (critical)
│   └── BlockchainEventProcessingBacklog (warning)
│
├── Indexer Alerts (4 rules)
│   ├── IndexerEventProcessingErrors (critical)
│   ├── IndexerEventLatencyHigh (warning)
│   ├── IndexerQueueBacklog (critical)
│   └── IndexerBatchFailureRate (warning)
│
├── Resource Alerts (5 rules)
│   ├── HighMemoryUsage (warning)
│   ├── CriticalMemoryUsage (critical)
│   ├── HighCpuUsage (warning)
│   └── EventLoopLagHigh (warning)
│
├── User & Authentication Alerts (1 rule)
│   └── HighAuthenticationFailureRate (warning)
│
└── Service Health Alerts (2 rules)
    ├── ServiceDown (critical)
    └── ScrapingErrors (warning)
```

## Recording Rules Hierarchy

```
Prometheus Recording Rules
│
├── HTTP Recording Rules (6 rules)
│   ├── http:requests:rate5m
│   ├── http:errors:rate5m
│   ├── http:slow_requests:rate5m
│   ├── http:request_duration:p50
│   ├── http:request_duration:p95
│   └── http:request_duration:p99
│
├── Database Recording Rules (6 rules)
│   ├── db:query:rate5m
│   ├── db:slow_queries:rate5m
│   ├── db:query_duration:p50
│   ├── db:query_duration:p95
│   ├── db:query_duration:p99
│   └── db:pool:utilization
│
├── Cache Recording Rules (5 rules)
│   ├── cache:hit_rate:5m
│   ├── redis:operation_duration:p50
│   ├── redis:operation_duration:p95
│   └── redis:operation_duration:p99
│
├── Business Recording Rules (8 rules)
│   ├── business:bets:rate5m
│   ├── business:wagered:total_1h
│   ├── business:payouts:rate5m
│   ├── business:payouts:failure_rate5m
│   ├── business:market_resolution:p50
│   ├── business:market_resolution:p95
│   └── business:market_resolution:p99
│
├── Blockchain Recording Rules (7 rules)
│   ├── blockchain:contract_invocations:rate5m
│   ├── blockchain:contract_failures:rate5m
│   ├── blockchain:contract_latency:p50
│   ├── blockchain:contract_latency:p95
│   ├── blockchain:contract_latency:p99
│   └── blockchain:events:rate5m
│
├── Indexer Recording Rules (8 rules)
│   ├── indexer:events:rate1m
│   ├── indexer:events:error_rate1m
│   ├── indexer:event_latency:p50
│   ├── indexer:event_latency:p95
│   ├── indexer:event_latency:p99
│   ├── indexer:batches:rate1m
│   ├── indexer:batch_latency:p50
│   ├── indexer:batch_latency:p95
│   └── indexer:batch_latency:p99
│
├── Resource Recording Rules (5 rules)
│   ├── resource:memory:max1h
│   ├── resource:memory:avg1h
│   ├── resource:cpu:max1h
│   ├── resource:cpu:avg1h
│   ├── resource:event_loop_lag:max1m
│   └── resource:event_loop_lag:avg1m
│
└── Error Recording Rules (3 rules)
    ├── errors:application:rate5m
    ├── errors:database:rate5m
    └── errors:external_service:rate5m
```

## Code Integration Points

```
Application Code
│
├── Controllers
│   ├── AuthController
│   │   └── recordUserRegistered()
│   │
│   ├── BetController
│   │   └── recordBetPlaced(outcome, amount)
│   │
│   └── PayoutController
│       └── recordBetPayout(amount) or recordBetPayoutFailure()
│
├── Services
│   ├── MarketService
│   │   ├── recordMarketCreated()
│   │   └── recordMarketResolutionTime(seconds)
│   │
│   ├── StellarService
│   │   ├── recordContractInvocation(contract, operation, latency)
│   │   └── recordContractInvocationFailure(contract, operation, error)
│   │
│   └── PayoutService
│       └── recordBetPayout(amount)
│
├── Middleware
│   ├── HTTP Metrics
│   │   └── httpMetrics - records all HTTP requests
│   │
│   ├── Database Monitoring
│   │   └── installDbMetricsListener() - tracks all queries
│   │
│   └── Error Handling
│       └── Records errors by type
│
└── Indexer
    ├── Event Processing
    │   └── recordEventSuccess/Failure(latency)
    │
    └── Queue Management
        └── setQueueDepth(count)
```

## Dashboard Structure

```
Grafana Dashboard Organization
│
├── Overview Panel
│   ├── Active markets (gauge)
│   ├── Total users (gauge)
│   ├── Bets placed (rate)
│   └── System health (status)
│
├── Request Performance
│   ├── Request rate (line chart)
│   ├── Error rate trend (line chart)
│   ├── Latency percentiles (line chart)
│   └── Top slow endpoints (bar chart)
│
├── Database Health
│   ├── Query rate (line chart)
│   ├── Query latency (line chart)
│   ├── Connection pool usage (gauge)
│   └── Slow queries (bar chart)
│
├── Business Metrics
│   ├── Bets placed trend (line chart)
│   ├── Total wagered (line chart)
│   ├── Payout success rate (line chart)
│   ├── Average bet size (gauge)
│   └── Active markets (line chart)
│
├── Blockchain Operations
│   ├── Contract invocations (line chart)
│   ├── Contract failure rate (line chart)
│   ├── Invocation latency (line chart)
│   └── Transaction fees (line chart)
│
├── Indexer Health
│   ├── Event processing rate (line chart)
│   ├── Event error rate (line chart)
│   ├── Queue depth (line chart)
│   ├── Event latency (line chart)
│   └── Batch latency (line chart)
│
├── System Resources
│   ├── Memory usage trend (line chart)
│   ├── CPU usage trend (line chart)
│   ├── Event loop lag (line chart)
│   └── GC pause times (line chart)
│
└── Alerts
    ├── Active alerts (table)
    ├── Alert history (table)
    └── Alert statistics (gauge)
```

## Integration Checklist

```
Integration Steps
│
├── Backend Service
│   ├── [ ] Import metrics service
│   ├── [ ] Start resource collection
│   ├── [ ] Record business operations
│   ├── [ ] Update business metrics periodically
│   └── [ ] Expose metrics endpoint
│
├── Indexer Service
│   ├── [ ] Start metrics server
│   ├── [ ] Record event processing
│   ├── [ ] Update queue depth
│   └── [ ] Expose metrics endpoints
│
├── Monitoring Stack
│   ├── [ ] Deploy Prometheus
│   ├── [ ] Load alert rules
│   ├── [ ] Load recording rules
│   ├── [ ] Configure AlertManager
│   └── [ ] Deploy Grafana
│
└── Verification
    ├── [ ] Metrics endpoints respond
    ├── [ ] Prometheus scraping works
    ├── [ ] Alerts trigger correctly
    └── [ ] Dashboard displays correctly
```

## Performance Thresholds Chart

```
Metric                      | Yellow Alert | Red Alert | Target
─────────────────────────────────────────────────────────────────
HTTP Request P95 Latency    | > 1s         | > 2s      | < 500ms
HTTP Error Rate             | > 2%         | > 5%      | < 0.1%
DB Query P99 Latency        | > 250ms      | > 500ms   | < 100ms
DB Slow Queries/sec         | > 5          | > 10      | < 1
Cache Hit Rate              | < 65%        | < 60%     | > 70%
Market Resolution P95       | > 3min       | > 5min    | < 1min
Contract Invocation P95     | > 5s         | > 10s     | < 2s
Event Processing Rate       | < 50/sec     | < 10/sec  | > 100/sec
Memory Usage                | > 85%        | > 95%     | < 60%
CPU Usage                   | > 80%        | > 90%     | < 40%
Event Loop Lag              | > 50ms       | > 100ms   | < 10ms
Connection Pool Usage       | > 80%        | > 95%     | < 50%
```

This visual reference provides a quick overview of the metrics implementation structure, hierarchy, and integration points.
