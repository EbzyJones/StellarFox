/**
 * Business Metrics Service
 * 
 * Records and tracks business-critical metrics such as:
 * - Market creation and resolution
 * - Bet placement and payouts
 * - User engagement
 * - Revenue metrics
 * 
 * These metrics are essential for monitoring platform health and business KPIs.
 */

import {
  marketsCreatedTotal,
  activeMarketsGauge,
  resolvedMarketsGauge,
  disputedMarketsGauge,
  marketResolutionLatency,
  betsPlacedTotal,
  totalWageredXlm,
  averageBetSizeXlm,
  betPayoutsTotal,
  betPayoutFailuresTotal,
  totalPaidOutXlm,
  usersRegisteredTotal,
  activeUsersGauge,
  totalUsersGauge,
  contractInvocationsTotal,
  contractInvocationFailuresTotal,
  contractInvocationLatency,
  transactionFeeCost,
} from './metrics.service';

/**
 * Record market creation
 */
export function recordMarketCreated(): void {
  marketsCreatedTotal.inc();
}

/**
 * Update active markets count
 */
export function updateActiveMarketsCount(count: number): void {
  activeMarketsGauge.set(count);
}

/**
 * Update resolved markets count
 */
export function updateResolvedMarketsCount(count: number): void {
  resolvedMarketsGauge.set(count);
}

/**
 * Update disputed markets count
 */
export function updateDisputedMarketsCount(count: number): void {
  disputedMarketsGauge.set(count);
}

/**
 * Record market resolution time (latency from lock to resolution)
 * @param resolutionTimeSeconds Time taken to resolve the market
 */
export function recordMarketResolutionTime(resolutionTimeSeconds: number): void {
  marketResolutionLatency.observe(resolutionTimeSeconds);
}

/**
 * Record a bet placement
 * @param outcome The bet outcome (e.g., 'fighter_a', 'fighter_b', 'draw')
 * @param amountXlm Amount wagered in XLM
 */
export function recordBetPlaced(outcome: string, amountXlm: number): void {
  betsPlacedTotal.labels(outcome).inc();
  totalWageredXlm.add(amountXlm);
}

/**
 * Update average bet size
 * @param averageXlm Average bet size in XLM
 */
export function updateAverageBetSize(averageXlm: number): void {
  averageBetSizeXlm.set(averageXlm);
}

/**
 * Record a successful bet payout
 * @param amountXlm Amount paid out in XLM
 */
export function recordBetPayout(amountXlm: number): void {
  betPayoutsTotal.inc();
  totalPaidOutXlm.add(amountXlm);
}

/**
 * Record a failed bet payout
 */
export function recordBetPayoutFailure(): void {
  betPayoutFailuresTotal.inc();
}

/**
 * Record user registration
 */
export function recordUserRegistered(): void {
  usersRegisteredTotal.inc();
}

/**
 * Update active users count
 */
export function updateActiveUsersCount(count: number): void {
  activeUsersGauge.set(count);
}

/**
 * Update total users count
 */
export function updateTotalUsersCount(count: number): void {
  totalUsersGauge.set(count);
}

/**
 * Record a contract invocation
 * @param contract Contract identifier (e.g., 'BetFactory', 'MarketResolver')
 * @param operation Operation name (e.g., 'placeBet', 'resolveMarket')
 * @param latencySeconds Time taken to execute the operation
 */
export function recordContractInvocation(
  contract: string,
  operation: string,
  latencySeconds: number,
): void {
  contractInvocationsTotal.labels(contract, operation).inc();
  contractInvocationLatency.labels(contract, operation).observe(latencySeconds);
}

/**
 * Record a contract invocation failure
 * @param contract Contract identifier
 * @param operation Operation name
 * @param errorType Type of error (e.g., 'timeout', 'revert', 'validation_error')
 */
export function recordContractInvocationFailure(
  contract: string,
  operation: string,
  errorType: string,
): void {
  contractInvocationFailuresTotal.labels(contract, operation, errorType).inc();
}

/**
 * Record transaction fee cost
 * @param feeXlm Fee cost in XLM
 */
export function recordTransactionFee(feeXlm: number): void {
  transactionFeeCost.set(feeXlm);
}

/**
 * Batch update multiple business metrics at once
 * Useful for periodic aggregations from the database
 */
export interface BusinessMetricsSnapshot {
  activeMarketsCount?: number;
  resolvedMarketsCount?: number;
  disputedMarketsCount?: number;
  activeUsersCount?: number;
  totalUsersCount?: number;
  averageBetSizeXlm?: number;
}

export function updateBusinessMetricsSnapshot(snapshot: BusinessMetricsSnapshot): void {
  if (snapshot.activeMarketsCount !== undefined) {
    updateActiveMarketsCount(snapshot.activeMarketsCount);
  }
  if (snapshot.resolvedMarketsCount !== undefined) {
    updateResolvedMarketsCount(snapshot.resolvedMarketsCount);
  }
  if (snapshot.disputedMarketsCount !== undefined) {
    updateDisputedMarketsCount(snapshot.disputedMarketsCount);
  }
  if (snapshot.activeUsersCount !== undefined) {
    updateActiveUsersCount(snapshot.activeUsersCount);
  }
  if (snapshot.totalUsersCount !== undefined) {
    updateTotalUsersCount(snapshot.totalUsersCount);
  }
  if (snapshot.averageBetSizeXlm !== undefined) {
    updateAverageBetSize(snapshot.averageBetSizeXlm);
  }
}
