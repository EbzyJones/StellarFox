// ============================================================
// Circuit Breaker — Indexer
// Lightweight implementation for the indexer service.
// No external dependencies (prom-client not available here).
//
// States:
//   CLOSED   — normal operation, calls pass through
//   OPEN     — circuit tripped; calls fail fast with CircuitBreakerError
//   HALF_OPEN — probe state; one test call is allowed through
//
// Transition rules:
//   CLOSED    → OPEN      when consecutive failures exceed threshold
//   OPEN      → HALF_OPEN after resetTimeout ms
//   HALF_OPEN → CLOSED    on success
//   HALF_OPEN → OPEN      on failure
// ============================================================

import { logger } from './logger';

export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Consecutive failures before opening the circuit. @default 5 */
  failureThreshold?: number;
  /** Milliseconds before transitioning OPEN → HALF_OPEN. @default 30_000 */
  resetTimeoutMs?: number;
  /** Optional per-call timeout in milliseconds. @default undefined (none) */
  callTimeoutMs?: number;
}

export class CircuitBreakerError extends Error {
  constructor(
    public readonly breakerName: string,
    public readonly state: CircuitBreakerState,
  ) {
    super(`Circuit breaker "${breakerName}" is ${state} — call rejected`);
    this.name = 'CircuitBreakerError';
    Object.setPrototypeOf(this, CircuitBreakerError.prototype);
  }
}

export class CircuitBreaker {
  private state: CircuitBreakerState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime: number | null = null;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly callTimeoutMs?: number;

  constructor(
    public readonly name: string,
    options: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.callTimeoutMs = options.callTimeoutMs;
  }

  getState(): CircuitBreakerState {
    return this.state;
  }

  getFailureCount(): number {
    return this.failureCount;
  }

  /**
   * Wraps an async operation with circuit-breaker protection.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.tryTransitionToHalfOpen();

    if (this.state === 'OPEN') {
      throw new CircuitBreakerError(this.name, this.state);
    }

    try {
      const result = await this.executeWithTimeout(fn);
      this.onSuccess();
      return result;
    } catch (err) {
      if (err instanceof CircuitBreakerError) throw err;
      this.onFailure(err);
      throw err;
    }
  }

  /** Manually trips the circuit open (e.g. admin override). */
  trip(): void {
    this.transition('OPEN');
    this.lastFailureTime = Date.now();
    logger.warn({ name: this.name }, 'Circuit breaker manually tripped');
  }

  /** Manually resets the circuit to CLOSED (e.g. admin override). */
  reset(): void {
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.transition('CLOSED');
    logger.info({ name: this.name }, 'Circuit breaker manually reset');
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async executeWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.callTimeoutMs) return fn();

    return new Promise<T>((resolve, reject) => {
      const id = setTimeout(
        () => reject(new Error(`Circuit breaker "${this.name}": call timed out after ${this.callTimeoutMs}ms`)),
        this.callTimeoutMs,
      );
      fn().then(
        (v) => { clearTimeout(id); resolve(v); },
        (e) => { clearTimeout(id); reject(e); },
      );
    });
  }

  private tryTransitionToHalfOpen(): void {
    if (
      this.state === 'OPEN' &&
      this.lastFailureTime !== null &&
      Date.now() - this.lastFailureTime >= this.resetTimeoutMs
    ) {
      this.transition('HALF_OPEN');
      logger.info({ name: this.name }, 'Circuit breaker entering HALF_OPEN — testing recovery');
    }
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.failureCount = 0;
      this.lastFailureTime = null;
      this.transition('CLOSED');
      logger.info({ name: this.name }, 'Circuit breaker closed — service recovered');
    } else {
      this.failureCount = 0;
    }
  }

  private onFailure(err: unknown): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    logger.warn(
      {
        name: this.name,
        failureCount: this.failureCount,
        threshold: this.failureThreshold,
        err: err instanceof Error ? err.message : String(err),
      },
      'Circuit breaker failure recorded',
    );

    if (this.state === 'HALF_OPEN' || this.failureCount >= this.failureThreshold) {
      this.transition('OPEN');
      logger.error(
        { name: this.name, failureCount: this.failureCount, resetAfterMs: this.resetTimeoutMs },
        'Circuit breaker opened — external service appears unhealthy',
      );
    }
  }

  private transition(newState: CircuitBreakerState): void {
    if (this.state === newState) return;
    const prev = this.state;
    this.state = newState;
    logger.info({ name: this.name, from: prev, to: newState }, 'Circuit breaker state transition');
  }
}

// ── Singleton registry ────────────────────────────────────────────────────────

const registry = new Map<string, CircuitBreaker>();

/**
 * Returns a named circuit breaker, creating it on first access.
 * Subsequent calls with the same name ignore options (singleton per name).
 */
export function getCircuitBreaker(
  name: string,
  options?: CircuitBreakerOptions,
): CircuitBreaker {
  if (!registry.has(name)) {
    registry.set(name, new CircuitBreaker(name, options));
    logger.info(
      {
        name,
        failureThreshold: options?.failureThreshold ?? 5,
        resetTimeoutMs: options?.resetTimeoutMs ?? 30_000,
      },
      'Circuit breaker registered',
    );
  }
  return registry.get(name)!;
}

/**
 * Returns a snapshot of all registered circuit breakers and their states.
 * Exposed on the /circuit-breakers health endpoint.
 */
export function getCircuitBreakerStatus(): Array<{
  name: string;
  state: CircuitBreakerState;
  failureCount: number;
}> {
  return Array.from(registry.values()).map((cb) => ({
    name: cb.name,
    state: cb.getState(),
    failureCount: cb.getFailureCount(),
  }));
}
