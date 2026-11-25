// ============================================================
// Adaptive Polling Tests
// ============================================================

import { describe, it, expect, beforeEach } from '@jest/globals';
import { AdaptivePoller } from '../adaptivePolling';
import { CircuitBreaker, CircuitBreakerError } from '../circuitBreaker';

describe('Adaptive Polling', () => {
  describe('AdaptivePoller', () => {
    let poller: AdaptivePoller;

    beforeEach(() => {
      poller = new AdaptivePoller({
        minIntervalMs: 1000,
        maxIntervalMs: 60000,
        initialIntervalMs: 5000,
        errorMultiplier: 1.5,
        successDivisor: 1.2,
        jitterPercent: 20,
      });
    });

    it('should initialize with default interval', () => {
      expect(poller.getInterval()).toBe(5000);
    });

    it('should decrease interval on success with events', () => {
      const initialInterval = poller.getInterval();
      poller.recordSuccess(10); // 10 events found
      poller.recordSuccess(5); // Another success with events
      const newInterval = poller.getInterval();
      // Should be lower than initial (with some jitter)
      expect(newInterval).toBeLessThanOrEqual(initialInterval);
    });

    it('should increase interval on error', () => {
      const initialInterval = poller.getInterval();
      const error = new Error('Connection timeout');
      poller.recordError(error);
      const newInterval = poller.getInterval();
      // Should be higher than initial
      expect(newInterval).toBeGreaterThan(initialInterval);
    });

    it('should exponentially backoff on consecutive errors', () => {
      const intervals: number[] = [poller.getInterval()];
      
      for (let i = 0; i < 3; i++) {
        poller.recordError(new Error('Error'));
        intervals.push(poller.getInterval());
      }

      // Each interval should be increasingly larger
      for (let i = 1; i < intervals.length; i++) {
        expect(intervals[i]).toBeGreaterThanOrEqual(intervals[i - 1]);
      }
    });

    it('should cap exponential growth at max interval', () => {
      for (let i = 0; i < 20; i++) {
        poller.recordError(new Error('Error'));
      }
      expect(poller.getInterval()).toBeLessThanOrEqual(60000);
    });

    it('should reset on success after errors', () => {
      poller.recordError(new Error('Error'));
      poller.recordError(new Error('Error'));
      const errorInterval = poller.getInterval();
      
      poller.recordSuccess(5);
      const newInterval = poller.getInterval();
      
      // Success should reduce backoff
      expect(newInterval).toBeLessThan(errorInterval);
    });

    it('should track metrics', () => {
      poller.recordSuccess(5);
      poller.recordError(new Error('Test'));
      const metrics = poller.getMetrics();

      expect(metrics.eventsProcessed).toBe(5);
      expect(metrics.totalPollAttempts).toBe(2);
      expect(metrics.totalFailedAttempts).toBe(1);
    });

    it('should detect backoff state', () => {
      expect(poller.isInBackoff()).toBe(false);
      poller.recordError(new Error('Error'));
      expect(poller.isInBackoff()).toBe(true);
    });

    it('should reset state', () => {
      poller.recordError(new Error('Error'));
      poller.recordError(new Error('Error'));
      poller.reset();
      
      const metrics = poller.getMetrics();
      expect(metrics.consecutiveErrors).toBe(0);
      expect(metrics.totalPollAttempts).toBe(0);
      expect(poller.getInterval()).toBe(5000);
    });
  });

  describe('CircuitBreaker (PollingCircuitBreaker)', () => {
    // Use a unique name per test to avoid singleton cross-contamination
    let testId: number;
    let breakerName: () => string;

    beforeEach(() => {
      testId = Date.now() + Math.random();
      breakerName = () => `test-cb-${testId}`;
    });

    it('should start in CLOSED state and pass calls through', async () => {
      const cb = new CircuitBreaker(breakerName(), { failureThreshold: 3, resetTimeoutMs: 1000 });
      expect(cb.getState()).toBe('CLOSED');
      const result = await cb.execute(() => Promise.resolve('ok'));
      expect(result).toBe('ok');
    });

    it('should open after failure threshold', async () => {
      const cb = new CircuitBreaker(breakerName(), { failureThreshold: 3, resetTimeoutMs: 1000 });
      const failFn = () => Promise.reject(new Error('fail'));

      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(failFn)).rejects.toThrow('fail');
      }

      expect(cb.getState()).toBe('OPEN');
      await expect(cb.execute(() => Promise.resolve('ok'))).rejects.toBeInstanceOf(CircuitBreakerError);
    });

    it('should transition to HALF_OPEN after resetTimeout', async () => {
      const cb = new CircuitBreaker(breakerName(), { failureThreshold: 3, resetTimeoutMs: 100 });
      const failFn = () => Promise.reject(new Error('fail'));

      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(failFn)).rejects.toThrow('fail');
      }
      expect(cb.getState()).toBe('OPEN');

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Next execute should transition to HALF_OPEN and let the call through
      const result = await cb.execute(() => Promise.resolve('recovered'));
      expect(result).toBe('recovered');
      expect(cb.getState()).toBe('CLOSED');
    });

    it('should re-open from HALF_OPEN on failure', async () => {
      const cb = new CircuitBreaker(breakerName(), { failureThreshold: 3, resetTimeoutMs: 100 });
      const failFn = () => Promise.reject(new Error('fail'));

      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(failFn)).rejects.toThrow('fail');
      }
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Probe call also fails → back to OPEN
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
      expect(cb.getState()).toBe('OPEN');
    });

    it('should reset to CLOSED via reset()', async () => {
      const cb = new CircuitBreaker(breakerName(), { failureThreshold: 3, resetTimeoutMs: 60_000 });
      const failFn = () => Promise.reject(new Error('fail'));

      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(failFn)).rejects.toThrow('fail');
      }

      cb.reset();
      expect(cb.getState()).toBe('CLOSED');
      const result = await cb.execute(() => Promise.resolve('ok'));
      expect(result).toBe('ok');
    });

    it('should report failure count', async () => {
      const cb = new CircuitBreaker(breakerName(), { failureThreshold: 10, resetTimeoutMs: 60_000 });
      const failFn = () => Promise.reject(new Error('fail'));

      await expect(cb.execute(failFn)).rejects.toThrow();
      await expect(cb.execute(failFn)).rejects.toThrow();
      expect(cb.getFailureCount()).toBe(2);
    });
  });
});
