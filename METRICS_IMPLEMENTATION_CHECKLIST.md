# Prometheus Metrics Implementation Checklist

This checklist verifies that all Prometheus metrics for critical operations are properly integrated.

## ✅ Core Metrics Infrastructure

### Backend Metrics Service
- [x] Core metrics definitions (`metrics.service.ts`)
  - [x] HTTP request metrics (latency, throughput, errors)
  - [x] Database query metrics (latency, slow queries, pool status)
  - [x] Cache metrics (hits, misses, Redis operations)
  - [x] WebSocket metrics (connections, messages)
  - [x] Business metrics (markets, bets, users)
  - [x] Blockchain metrics (contracts, transactions)
  - [x] Error metrics (application, database, external)

- [ ] Integration with Express middleware
  - [ ] `httpMetrics` middleware installed in `index.ts`
  - [ ] Request ID tracking enabled
  - [ ] Error middleware records metrics

### Indexer Metrics
- [x] Prometheus metrics integration (`indexer/src/metrics.ts`)
  - [x] Event processing metrics (success, failure, latency)
  - [x] Batch processing metrics
  - [x] Queue depth tracking
  - [x] Throughput calculation

- [x] Metrics server (`indexer/src/metricsServer.ts`)
  - [x] Prometheus text format endpoint
  - [x] JSON format endpoint
  - [x] Health check endpoint

## ✅ Business Metrics

### Market Operations
- [x] Market creation tracking (`recordMarketCreated()`)
- [x] Active markets gauge (`updateActiveMarketsCount()`)
- [x] Market resolution latency (`recordMarketResolutionTime()`)
- [x] Market status transitions tracked

### Bet Operations
- [x] Bet placement recording (`recordBetPlaced()`)
- [x] Average bet size tracking
- [x] Total wagered accumulation
- [x] Payout success recording (`recordBetPayout()`)
- [x] Payout failure tracking (`recordBetPayoutFailure()`)

### User Engagement
- [x] User registration tracking (`recordUserRegistered()`)
- [x] Active users gauge
- [x] Total users gauge
- [x] Auth failure tracking

### Revenue Metrics
- [x] Transaction fee tracking
- [x] Contract invocation recording
- [x] Contract failure rate tracking

## ✅ Resource Utilization

### System Metrics
- [x] Memory usage percentage (`memoryUsagePercent`)
- [x] CPU usage percentage (`cpuUsagePercent`)
- [x] Event loop lag measurement (`eventLoopLagMs`)

### Connection Pools
- [x] Database pool size gauge
- [x] Database available connections gauge
- [x] Redis pool size gauge

### Collection Service
- [x] Resource metrics collector (`resourceMetrics.service.ts`)
  - [x] `collectResourceMetrics()` function
  - [x] `startResourceMetricsCollection()` periodic collection
  - [x] Configurable collection interval

## ✅ Indexer Operations

### Event Processing
- [x] Event success counter
- [x] Event failure counter
- [x] Event latency histogram
- [x] Event type classification

### Batch Processing
- [x] Batch success counter
- [x] Batch failure counter
- [x] Batch latency histogram

### Queue Management
- [x] Queue depth gauge
- [x] Events per second throughput
- [x] Batches per minute throughput
- [x] Queue operations (increment, decrement, set)

### Ledger Tracking
- [x] Last processed ledger sequence
- [x] Polling interval gauge
- [x] Ledger continuity breaks counter

## ✅ Configuration Files

### Prometheus Configuration
- [x] `monitoring/prometheus/prometheus-updated.yml`
  - [x] Backend scrape config
  - [x] Indexer scrape config
  - [x] Database exporter config
  - [x] Redis exporter config
  - [x] Node exporter config
  - [x] Appropriate scrape intervals

### Alert Rules
- [x] `monitoring/prometheus/rules/alerts-updated.yml`
  - [x] HTTP error rate alerts
  - [x] Slow request alerts
  - [x] Database query alerts
  - [x] Connection pool alerts
  - [x] Business metric alerts
  - [x] Blockchain operation alerts
  - [x] Indexer alerts
  - [x] Resource utilization alerts
  - [x] Service health alerts

### Recording Rules
- [x] `monitoring/prometheus/rules/recording-rules-updated.yml`
  - [x] HTTP metrics pre-aggregations
  - [x] Database metrics pre-aggregations
  - [x] Business metrics calculations
  - [x] Blockchain metrics aggregations
  - [x] Indexer metrics pre-calculations
  - [x] Error rate calculations

## ✅ Documentation

- [x] `PROMETHEUS_METRICS_GUIDE.md`
  - [x] Architecture overview
  - [x] Metric categories with descriptions
  - [x] Recording rules documentation
  - [x] Alert thresholds explained
  - [x] Usage examples in code
  - [x] Configuration instructions
  - [x] Dashboard panel suggestions
  - [x] Best practices section
  - [x] Troubleshooting guide

- [x] `METRICS_INTEGRATION_EXAMPLES.md`
  - [x] Backend integration examples
  - [x] Indexer integration examples
  - [x] Business metrics recording examples
  - [x] Resource monitoring examples
  - [x] Custom middleware examples
  - [x] Database monitoring examples
  - [x] Unit test examples

- [x] `METRICS_QUICK_START.md`
  - [x] 5-minute setup guide
  - [x] Key metrics to monitor
  - [x] Common queries
  - [x] Dashboard creation steps
  - [x] Troubleshooting section
  - [x] Common commands

## ✅ Service Files

### Backend Services
- [x] `backend/src/services/metrics.service.ts`
  - [x] 40+ metric definitions
  - [x] Export formats (JSON, CSV)
  - [x] Prometheus registry export

- [x] `backend/src/services/businessMetrics.service.ts`
  - [x] Business operation recording functions
  - [x] Market metrics recording
  - [x] Bet metrics recording
  - [x] User engagement tracking
  - [x] Batch update functionality

- [x] `backend/src/services/resourceMetrics.service.ts`
  - [x] Memory usage tracking
  - [x] CPU usage calculation
  - [x] Event loop lag measurement
  - [x] Connection pool updates
  - [x] Periodic collection setup

### Indexer Services
- [x] `indexer/src/metrics.ts` (enhanced)
  - [x] Prometheus metric collectors
  - [x] Event processing tracking
  - [x] Batch processing tracking
  - [x] Queue depth management
  - [x] Throughput calculation
  - [x] Text format export

- [x] `indexer/src/metricsServer.ts`
  - [x] Express metrics server
  - [x] Health check endpoint
  - [x] JSON metrics endpoint
  - [x] Prometheus format endpoint
  - [x] Custom indexer metrics endpoint

## 📋 Integration Tasks (In Progress)

### Backend Integration
- [ ] Import and initialize metrics in main server
  - [ ] Add `startResourceMetricsCollection()` to index.ts
  - [ ] Add business metrics update interval
  - [ ] Add database pool metrics updates
  - [ ] Add Redis pool metrics updates

- [ ] Integrate metrics recording in controllers
  - [ ] Auth controller - record user registration, auth failures
  - [ ] Bet controller - record bet placement
  - [ ] Market controller - record market operations
  - [ ] Payout service - record payout success/failure

- [ ] Database integration
  - [ ] Install query monitoring listener
  - [ ] Record query latency metrics
  - [ ] Track slow queries

- [ ] Cache integration
  - [ ] Record cache hits/misses
  - [ ] Track Redis operations

### Indexer Integration
- [ ] Initialize metrics server in main
- [ ] Record event processing metrics
- [ ] Record batch processing metrics
- [ ] Update queue depth tracking
- [ ] Track polling interval changes
- [ ] Record ledger continuity breaks

### Monitoring Setup
- [ ] Deploy Prometheus with updated config
- [ ] Set up AlertManager
- [ ] Create Grafana dashboards
- [ ] Configure notification channels

## 📊 Verification Tasks

### Metrics Availability
- [ ] Verify backend metrics endpoint responds
  ```bash
  curl http://localhost:9090/metrics
  ```

- [ ] Verify indexer metrics endpoint responds
  ```bash
  curl http://localhost:9091/metrics
  ```

- [ ] Check Prometheus scrape targets
  - [ ] Backend target showing "UP"
  - [ ] Indexer target showing "UP"

### Metrics Collection
- [ ] Test HTTP metric recording
  - [ ] Make API request
  - [ ] Verify `http_requests_total` incremented
  - [ ] Verify `http_request_duration_seconds` recorded

- [ ] Test business metric recording
  - [ ] Place a bet
  - [ ] Verify `bets_placed_total` incremented
  - [ ] Verify `total_wagered_xlm` updated

- [ ] Test indexer metric recording
  - [ ] Process blockchain event
  - [ ] Verify event metrics recorded
  - [ ] Verify queue depth updated

### Alert Configuration
- [ ] Load alert rules into Prometheus
- [ ] Verify alert evaluation is running
- [ ] Test alert triggering mechanism

## 🎯 Performance Targets

### Latency Thresholds
- [ ] HTTP P95: < 2 seconds
- [ ] HTTP P99: < 5 seconds
- [ ] DB query P95: < 100ms
- [ ] DB query P99: < 500ms
- [ ] Market resolution (P95): < 5 minutes
- [ ] Contract invocation (P95): < 10 seconds

### Throughput Targets
- [ ] Min concurrent requests: 100+
- [ ] Min bets per minute: 10+
- [ ] Min events processed per second: 100+

### Error Rate Targets
- [ ] HTTP error rate: < 0.1%
- [ ] Database error rate: < 0.01%
- [ ] Contract invocation failure rate: < 1%
- [ ] Event processing failure rate: < 0.5%

## 🔍 Monitoring Checks

### Daily Checks
- [ ] Review Prometheus scrape success rate
- [ ] Check for any active alerts
- [ ] Review error rate trends
- [ ] Check resource utilization

### Weekly Checks
- [ ] Review performance metrics trends
- [ ] Analyze slow query reports
- [ ] Check business KPI trends
- [ ] Review alert accuracy (false positives)

### Monthly Checks
- [ ] Capacity planning review
- [ ] Metric cardinality audit
- [ ] Alert threshold optimization
- [ ] Dashboard review and updates

## 📝 Notes

### Dependencies
- `prom-client` >= 15.1.3 (backend)
- `prom-client` >= 15.1.3 (indexer)
- Prometheus >= 2.40.0
- Grafana >= 9.0.0 (optional but recommended)

### Database Schema (Optional)
For historical metrics storage, consider:
```sql
CREATE TABLE metrics_history (
  id SERIAL PRIMARY KEY,
  metric_name VARCHAR(255),
  labels JSONB,
  value FLOAT,
  recorded_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_metrics_recorded_at ON metrics_history(recorded_at DESC);
```

### Grafana Dashboard JSON
Export dashboard JSON from Grafana for version control:
```bash
curl http://grafana:3000/api/dashboards/db/bankerchanger-dashboard > dashboard.json
```

## ✨ Completed Items Summary

**Infrastructure:** 10/10 ✅
- Core metrics definitions
- Business metrics service
- Resource metrics service
- Indexer metrics integration
- Metrics HTTP server

**Configuration:** 3/3 ✅
- Prometheus configuration
- Alert rules
- Recording rules

**Documentation:** 3/3 ✅
- Full metrics guide
- Integration examples
- Quick start guide

**Total Progress:** 16/16 Core Components ✅

**Remaining:** Integration into live services (backend/indexer startup, controller registration, etc.)
