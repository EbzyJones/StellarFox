/**
 * useOfflineWatchlist — offline-aware wrapper around useWatchlist.
 *
 * When the user is online: delegates directly to the live API.
 * When offline: queues mutations in the sync queue so they replay on reconnect.
 *
 * The optimistic local state update is applied immediately in both cases so
 * the UI always reflects the user's intent without waiting for the network.
 */

import { useState, useEffect, useCallback } from 'react';
import { fetchWatchlist, addToWatchlist, removeFromWatchlist } from '../services/api';
import { enqueueSync } from '../services/offlineStore';
import { useOfflineContext } from '../providers/OfflineProvider';
import type { WatchlistMarket } from '../types';

export interface UseOfflineWatchlistResult {
  watchlist: WatchlistMarket[];
  isLoading: boolean;
  error: Error | null;
  /** Add a market; queued when offline */
  add: (marketId: string) => Promise<void>;
  /** Remove a market; queued when offline */
  remove: (marketId: string) => Promise<void>;
  /** Trigger a manual re-fetch (no-op when offline) */
  refetch: () => void;
}

export function useOfflineWatchlist(token?: string): UseOfflineWatchlistResult {
  const { isOnline } = useOfflineContext();
  const [watchlist, setWatchlist] = useState<WatchlistMarket[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!token || !isOnline) return;

    setIsLoading(true);
    fetchWatchlist(token)
      .then((data) => {
        setWatchlist(data);
        setError(null);
      })
      .catch((e) => setError(e as Error))
      .finally(() => setIsLoading(false));
  }, [token, tick, isOnline]);

  const add = useCallback(
    async (marketId: string) => {
      if (!token) throw new Error('Not authenticated');

      // Optimistic UI update
      setWatchlist((prev) => {
        if (prev.some((m) => m.id === marketId)) return prev;
        // Add a placeholder entry — the full data arrives on the next fetch
        const placeholder: WatchlistMarket = {
          id: marketId,
          title: '',
          status: 'open',
          fighter_a: '',
          fighter_b: '',
          closing_at: '',
          watchlisted_at: new Date().toISOString(),
        };
        return [...prev, placeholder];
      });

      if (!isOnline) {
        await enqueueSync('watchlist_add', { marketId, token });
        return;
      }

      try {
        await addToWatchlist(marketId, token);
        // Refresh to get the full market data
        setTick((t) => t + 1);
      } catch (err) {
        // Roll back optimistic update on failure
        setWatchlist((prev) => prev.filter((m) => m.id !== marketId));
        throw err;
      }
    },
    [token, isOnline],
  );

  const remove = useCallback(
    async (marketId: string) => {
      if (!token) throw new Error('Not authenticated');

      // Optimistic removal
      setWatchlist((prev) => prev.filter((m) => m.id !== marketId));

      if (!isOnline) {
        await enqueueSync('watchlist_remove', { marketId, token });
        return;
      }

      try {
        await removeFromWatchlist(marketId, token);
      } catch (err) {
        // Roll back and re-fetch on failure
        setTick((t) => t + 1);
        throw err;
      }
    },
    [token, isOnline],
  );

  const refetch = useCallback(() => {
    if (isOnline) setTick((t) => t + 1);
  }, [isOnline]);

  return { watchlist, isLoading, error, add, remove, refetch };
}
