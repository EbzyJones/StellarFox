/**
 * Resource Utilization Metrics Service
 * 
 * Tracks system resource usage:
 * - Memory usage
 * - CPU usage
 * - Event loop lag
 * - Database connection pool status
 * - Redis connection pool status
 * 
 * These metrics are crucial for capacity planning and identifying bottlenecks.
 */

import { memoryUsagePercent, cpuUsagePercent, eventLoopLagMs } from './metrics.service';
import { dbConnectionPoolSize, dbConnectionPoolAvailable, redisConnectionPoolSize } from './metrics.service';
import os from 'os';

let eventLoopLagStart = Date.now();
let previousCpuUsage = process.cpuUsage();

/**
 * Update memory usage metrics
 * Calculates memory usage as percentage of total available memory
 */
export function updateMemoryMetrics(): void {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const usagePercent = (usedMemory / totalMemory) * 100;
  
  memoryUsagePercent.set(usagePercent);
}

/**
 * Update CPU usage metrics
 * Calculates CPU usage based on process CPU time
 */
export function updateCpuMetrics(): void {
  const currentCpuUsage = process.cpuUsage(previousCpuUsage);
  const totalCpuTime = currentCpuUsage.user + currentCpuUsage.system;
  const cpuCores = os.cpus().length;
  
  // Convert microseconds to milliseconds and normalize by core count
  const cpuPercent = (totalCpuTime / 1000) / (100 * cpuCores);
  
  cpuUsagePercent.set(cpuPercent);
  previousCpuUsage = process.cpuUsage();
}

/**
 * Measure and update event loop lag
 * Runs a setImmediate to measure how long the event loop takes to execute it
 */
export function measureEventLoopLag(): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    setImmediate(() => {
      const lag = Date.now() - start;
      eventLoopLagMs.set(lag);
      resolve();
    });
  });
}

/**
 * Update database connection pool metrics
 * @param poolSize Total size of the connection pool
 * @param available Number of available connections
 */
export function updateDbConnectionPoolMetrics(poolSize: number, available: number): void {
  dbConnectionPoolSize.set(poolSize);
  dbConnectionPoolAvailable.set(available);
}

/**
 * Update Redis connection pool metrics
 * @param poolSize Total size of the connection pool
 */
export function updateRedisConnectionPoolMetrics(poolSize: number): void {
  redisConnectionPoolSize.set(poolSize);
}

/**
 * Periodic resource metrics collector
 * Should be called on a regular interval (e.g., every 10 seconds)
 */
export async function collectResourceMetrics(): Promise<void> {
  updateMemoryMetrics();
  updateCpuMetrics();
  await measureEventLoopLag();
}

/**
 * Start periodic resource metrics collection
 * @param intervalMs Interval in milliseconds (default: 10000ms = 10 seconds)
 * @returns Interval ID for cleanup
 */
export function startResourceMetricsCollection(intervalMs: number = 10000): NodeJS.Timeout {
  return setInterval(() => {
    collectResourceMetrics().catch((err) => {
      console.error('Error collecting resource metrics:', err);
    });
  }, intervalMs);
}
