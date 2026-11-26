// ============================================================
// BANKERCHANGER — Adaptive Polling Service
// Implements intelligent polling intervals, error recovery, and backoff strategies
// ============================================================

import { calculateBackoff, loadBackoffConfigFromEnv } from './backoff';

// Re-export the shared circuit breaker so callers that previously imported
// PollingCircuitBreaker from this module don't need to change their import path.
export { CircuitBreaker as PollingCircuitBreaker, getCircuitBreaker, CircuitBreakerError } from './circuitBreaker';

export interface AdaptivePollingConfig {
  minIntervalMs: number;
  maxIntervalMs: number;
  initialIntervalMs: number;
  errorMultiplier: number;
  successDivisor: number;
  jitterPercent: number;
  maxConsecutiveErrors: number;
  recoveryMultiplier: number;
}

export const DEFAULT_POLLING_CONFIG: AdaptivePollingConfig = {
  minIntervalMs: parseInt(process.env.POLLING_MIN_INTERVAL_MS || '1000', 10),
  maxIntervalMs: parseInt(process.env.POLLING_MAX_INTERVAL_MS || '60000', 10),
  initialIntervalMs: parseInt(process.env.POLLING_INITIAL_INTERVAL_MS || '5000', 10),
  errorMultiplier: parseFloat(process.env.POLLING_ERROR_MULTIPLIER || '1.5'),
  successDivisor: parseFloat(process.env.POLLING_SUCCESS_DIVISOR || '1.2'),
  jitterPercent: parseInt(process.env.POLLING_JITTER_PERCENT || '20', 10),
  maxConsecutiveErrors: parseInt(process.env.POLLING_MAX_ERRORS || '10', 10),
  recoveryMultiplier: parseFloat(process.env.POLLING_RECOVERY_MULTIPLIER || '0.9'),
};

export interface PollingMetrics {
  consecutiveErrors: number;
  consecutiveSuccesses: number;
  currentIntervalMs: number;
  eventsProcessed: number;
  lastErrorTimestamp: number | null;
  lastSuccessTimestamp: number | null;
  totalPollAttempts: number;
  totalFailedAttempts: number;
  averageEventsPerPoll: number;
  lastIntervalAdjustmentReason: string | null;
}

export class AdaptivePoller {
  private config: AdaptivePollingConfig;
  private metrics: PollingMetrics;
  private isBackingOff = false;
  private backoffStartTime: number | null = null;

  constructor(config?: Partial<AdaptivePollingConfig>) {
    this.config = { ...DEFAULT_POLLING_CONFIG, ...config };
    this.metrics = {
      consecutiveErrors: 0,
      consecutiveSuccesses: 0,
      currentIntervalMs: this.config.initialIntervalMs,
      eventsProcessed: 0,
      lastErrorTimestamp: null,
      lastSuccessTimestamp: null,
      totalPollAttempts: 0,
      totalFailedAttempts: 0,
      averageEventsPerPoll: 0,
      lastIntervalAdjustmentReason: null,
    };
  }

  /**
   * Calculates the next polling interval after a successful poll
   */
  recordSuccess(eventsCount: number): void {
    this.metrics.totalPollAttempts++;
    this.metrics.lastSuccessTimestamp = Date.now();
    this.metrics.consecutiveSuccesses++;
    this.metrics.consecutiveErrors = 0;
    this.metrics.eventsProcessed += eventsCount;

    // Update average events per poll
    this.metrics.averageEventsPerPoll =
      (this.metrics.averageEventsPerPoll * (this.metrics.totalPollAttempts - 1) + eventsCount) /
      this.metrics.totalPollAttempts;

    // If events were found, we can poll faster
    if (eventsCount > 0 && this.metrics.consecutiveSuccesses >= 2) {
      const newInterval = Math.max(
        this.config.minIntervalMs,
        this.metrics.currentIntervalMs / this.config.successDivisor,
      );
      this.adjustInterval(newInterval, 'high_activity_detected');
    } else if (this.metrics.consecutiveSuccesses >= 5) {
      // Gradually decrease interval after multiple successful polls
      const newInterval = Math.max(
        this.config.minIntervalMs,
        this.metrics.currentIntervalMs * this.config.recoveryMultiplier,
      );
      this.adjustInterval(newInterval, 'recovery_mode');
    }

    // Clear backoff state on success
    this.isBackingOff = false;
    this.backoffStartTime = null;
  }

  /**
   * Calculates the next polling interval after a failed poll
   */
  recordError(error: Error): void {
    this.metrics.totalPollAttempts++;
    this.metrics.totalFailedAttempts++;
    this.metrics.lastErrorTimestamp = Date.now();
    this.metrics.consecutiveErrors++;
    this.metrics.consecutiveSuccesses = 0;

    const errorMessage = error?.message || 'Unknown error';

    if (this.metrics.consecutiveErrors === 1) {
      this.isBackingOff = true;
      this.backoffStartTime = Date.now();
    }

    // Exponentially back off on consecutive errors
    const backoffFactor = Math.min(
      this.config.errorMultiplier ** (this.metrics.consecutiveErrors - 1),
      Math.pow(this.config.errorMultiplier, 5), // Cap exponential growth
    );

    const newInterval = Math.min(
      this.config.maxIntervalMs,
      this.metrics.currentIntervalMs * backoffFactor,
    );

    this.adjustInterval(newInterval, `error_backoff_${this.metrics.consecutiveErrors}`);

    // Log warnings for critical error thresholds
    if (this.metrics.consecutiveErrors === Math.floor(this.config.maxConsecutiveErrors / 2)) {
      console.warn(`[AdaptivePoller] ${Math.floor(this.config.maxConsecutiveErrors / 2)} consecutive errors. Increasing backoff.`);
    }

    if (this.metrics.consecutiveErrors >= this.config.maxConsecutiveErrors) {
      console.error(
        `[AdaptivePoller] Max consecutive errors (${this.config.maxConsecutiveErrors}) reached. Consider circuit breaker pattern.`,
        { lastError: errorMessage },
      );
    }
  }

  /**
   * Adjusts the polling interval with jitter to prevent thundering herd
   */
  private adjustInterval(newInterval: number, reason: string): void {
    const jitterAmount = (newInterval * this.config.jitterPercent) / 100;
    const jitter = (Math.random() - 0.5) * 2 * jitterAmount;
    
    this.metrics.currentIntervalMs = Math.max(
      this.config.minIntervalMs,
      Math.min(this.config.maxIntervalMs, newInterval + jitter),
    );
    this.metrics.lastIntervalAdjustmentReason = reason;
  }

  /**
   * Gets the current polling interval
   */
  getInterval(): number {
    return Math.floor(this.metrics.currentIntervalMs);
  }

  /**
   * Gets current polling metrics for monitoring
   */
  getMetrics(): PollingMetrics {
    return { ...this.metrics };
  }

  /**
   * Checks if the poller is currently in backoff state
   */
  isInBackoff(): boolean {
    return this.isBackingOff;
  }

  /**
   * Gets estimated recovery time if in backoff
   */
  getEstimatedRecoveryTime(): number | null {
    if (!this.isBackingOff || !this.backoffStartTime) return null;

    const timeInBackoff = Date.now() - this.backoffStartTime;
    const estimatedRecoveryMs = this.metrics.currentIntervalMs * 5;
    
    return Math.max(0, estimatedRecoveryMs - timeInBackoff);
  }

  /**
   * Resets metrics (useful for testing or circuit breaker recovery)
   */
  reset(): void {
    this.metrics = {
      consecutiveErrors: 0,
      consecutiveSuccesses: 0,
      currentIntervalMs: this.config.initialIntervalMs,
      eventsProcessed: 0,
      lastErrorTimestamp: null,
      lastSuccessTimestamp: null,
      totalPollAttempts: 0,
      totalFailedAttempts: 0,
      averageEventsPerPoll: 0,
      lastIntervalAdjustmentReason: null,
    };
    this.isBackingOff = false;
    this.backoffStartTime = null;
  }
}

/**
 * Implements circuit breaker pattern for polling.
 * @deprecated Use `PollingCircuitBreaker` (re-exported from `./circuitBreaker`) instead.
 * This stub is kept for any code that constructs it via `new PollingCircuitBreaker(...)`
 * with custom thresholds before the registry was available.
 */
// (class removed — see re-export above)
