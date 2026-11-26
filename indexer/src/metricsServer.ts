/**
 * Metrics Server for Indexer
 * 
 * Provides HTTP endpoints for exporting metrics in both JSON and Prometheus formats.
 * Allows monitoring and observability of the blockchain event indexer.
 */

import express, { Express, Response } from 'express';
import { getMetricsSnapshot, getPrometheusMetrics, exportPrometheusMetrics } from './metrics';

export interface MetricsServerConfig {
  port: number;
  host?: string;
}

/**
 * Create and start a metrics HTTP server
 * @param config Configuration for the metrics server
 * @returns Express app instance
 */
export function createMetricsServer(config: MetricsServerConfig): Express {
  const app = express();
  const { port, host = 'localhost' } = config;

  // ── Health check endpoint ────────────────────────────────────────────────
  app.get('/health', (_, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });

  // ── JSON metrics endpoint ────────────────────────────────────────────────
  app.get('/metrics/json', (_, res) => {
    const snapshot = getMetricsSnapshot();
    res.json(snapshot);
  });

  // ── Prometheus text format endpoint ──────────────────────────────────────
  app.get('/metrics', async (_, res) => {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    try {
      const metrics = await exportPrometheusMetrics();
      res.send(metrics);
    } catch (error) {
      console.error('Error exporting Prometheus metrics:', error);
      res.status(500).send('Error exporting metrics');
    }
  });

  // ── Custom Prometheus metrics endpoint (text format) ─────────────────────
  app.get('/metrics/indexer', (_, res) => {
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(getPrometheusMetrics());
  });

  // ── 404 handler ──────────────────────────────────────────────────────────
  app.use((_, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Start the server
  app.listen(port, host, () => {
    console.log(`Metrics server listening on http://${host}:${port}`);
  });

  return app;
}

/**
 * Example usage in indexer:
 * 
 * ```typescript
 * import { createMetricsServer } from './metricsServer';
 * 
 * // Start metrics server on port 9090
 * const metricsApp = createMetricsServer({ port: 9090 });
 * ```
 * 
 * Endpoints:
 * - GET /health -> health check
 * - GET /metrics -> Prometheus format
 * - GET /metrics/json -> JSON format
 * - GET /metrics/indexer -> Custom indexer metrics in Prometheus format
 */
