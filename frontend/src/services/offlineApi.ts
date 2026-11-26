/**
 * offlineApi — local-first wrappers around the core API calls.
 *
 * fetchMarketByIdWithCache
 *   Online:  fetches from the server, persists to IndexedDB, returns fresh data.
 *   Offline: returns the IndexedDB-cached copy (or throws if none exists).
 *
 * fetchMarketsWithCache
 *   Online:  fetches from the server, persists each market to IndexedDB, returns fresh data.
 *   Offline: returns all cached markets as a synthetic list response.
 */

import { fetchMarketById, fetchMarkets } from './api';
import {
  cacheMarket,
  getCachedMarket,
  getAllCachedMarkets,
  type CachedMarket,
} from './offlineStore';
import type { Market, MarketStatus } from '../types';
import type { MarketFilters, PaginationParams, MarketListResponse } from './api';

/** Error thrown when a market is requested offline but not in the local cache. */
export class OfflineCacheMissError extends Error {
  constructor(marketId: string) {
    super(`Market ${marketId} is not in the offline cache`);
    this.name = 'OfflineCacheMissError';
  }
}

// ---------------------------------------------------------------------------
// Market detail
// ---------------------------------------------------------------------------

/**
 * Returns a market, writing through to the local cache.
 * Falls back to the cache when the network is unavailable.
 *
 * @param marketId   The market ID to fetch.
 * @param isOnline   Pass from useNetworkStatus / useOfflineContext.
 */
export async function fetchMarketByIdWithCache(
  marketId: string,
  isOnline: boolean,
): Promise<Market> {
  if (isOnline) {
    try {
      const market = await fetchMarketById(marketId);
      // Best-effort cache write; don't block the return on IDB errors
      persistMarket(market).catch(() => {});
      return market;
    } catch (err) {
      // Network / server error — try the cache as a fallback
      const cached = await getCachedMarket(marketId).catch(() => null);
      if (cached) return cached.data as Market;
      throw err;
    }
  }

  // Offline path
  const cached = await getCachedMarket(marketId).catch(() => null);
  if (cached) return cached.data as Market;
  throw new OfflineCacheMissError(marketId);
}

// ---------------------------------------------------------------------------
// Market list
// ---------------------------------------------------------------------------

/**
 * Returns a market list, writing through to the local cache.
 * Falls back to cached markets (without server-side filtering) when offline.
 *
 * @param filters     Optional server-side filters (applied locally when offline).
 * @param pagination  Ignored when offline — the full cached set is returned.
 * @param isOnline    Pass from useNetworkStatus / useOfflineContext.
 */
export async function fetchMarketsWithCache(
  filters: MarketFilters | undefined,
  pagination: PaginationParams | undefined,
  isOnline: boolean,
): Promise<MarketListResponse> {
  if (isOnline) {
    try {
      const response = await fetchMarkets(filters, pagination);
      response.markets.forEach((m) => persistMarket(m).catch(() => {}));
      return response;
    } catch (err) {
      // Fall through to offline cache
      const offline = await buildOfflineMarketList(filters);
      if (offline.markets.length > 0) return offline;
      throw err;
    }
  }

  return buildOfflineMarketList(filters);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function persistMarket(market: Market): Promise<void> {
  const entry: CachedMarket = {
    market_id: market.market_id,
    data: market,
    serverUpdatedAt: parseServerTimestamp(market),
    cachedAt: Date.now(),
  };
  await cacheMarket(entry);
}

/**
 * Derive a comparable server timestamp from the market object.
 * Uses updated_at if present, otherwise resolved_at → created_at → now.
 */
function parseServerTimestamp(market: Market): number {
  const candidate =
    (market as any).updated_at ||
    (market as any).resolved_at ||
    (market as any).created_at;
  if (candidate) {
    const ms = new Date(candidate).getTime();
    if (!isNaN(ms)) return ms;
  }
  return Date.now();
}

async function buildOfflineMarketList(
  filters?: MarketFilters,
): Promise<MarketListResponse> {
  const cached = await getAllCachedMarkets().catch(() => [] as CachedMarket[]);
  let markets = cached.map((c) => c.data as Market);

  // Apply client-side filtering to match what the server would do
  if (filters?.status) {
    markets = markets.filter((m) => m.status === (filters.status as MarketStatus));
  }
  if (filters?.category) {
    markets = markets.filter(
      (m) => (m as any).category?.toUpperCase() === filters.category?.toUpperCase(),
    );
  }
  if (filters?.search) {
    const q = filters.search.toLowerCase();
    markets = markets.filter(
      (m) =>
        m.fighter_a?.toLowerCase().includes(q) ||
        m.fighter_b?.toLowerCase().includes(q) ||
        (m as any).title?.toLowerCase().includes(q),
    );
  }

  return {
    markets,
    total: markets.length,
    page: 1,
    limit: markets.length,
  };
}
