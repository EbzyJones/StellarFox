/**
 * useOfflineSync — drives the sync queue drain and exposes sync state to the UI.
 *
 * Call this once at the top of the component tree (OfflineProvider).
 * It listens for the browser coming back online and triggers SyncEngine.drain().
 *
 * Returns:
 *   isOnline       — current network status
 *   isSyncing      — true while the queue drain is running
 *   pendingCount   — approximate number of items waiting to sync
 *   lastSyncError  — set if the last drain had any failures
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useNetworkStatus } from './useNetworkStatus';
import { SyncEngine, type SyncProgressEvent } from '../services/syncEngine';
import { getSyncQueueCount } from '../services/offlineStore';

export interface OfflineSyncState {
  isOnline: boolean;
  isSyncing: boolean;
  pendingCount: number;
  lastSyncError: string | null;
}

export function useOfflineSync(): OfflineSyncState {
  const { isOnline, wasOffline, acknowledgeReconnect } = useNetworkStatus();
  const [isSyncing, setIsSyncing] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const engineRef = useRef(SyncEngine.getInstance());

  // Poll the queue size so the counter stays fresh while offline
  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;

    const refresh = () =>
      getSyncQueueCount()
        .then(setPendingCount)
        .catch(() => {/* IDB not available in SSR */});

    refresh();

    if (!isOnline) {
      // Update count more frequently while offline (user may keep queuing items)
      timer = setInterval(refresh, 5_000);
    }

    return () => clearInterval(timer);
  }, [isOnline]);

  // Subscribe to sync progress events
  useEffect(() => {
    const engine = engineRef.current;

    const unsubscribe = engine.onProgress((event: SyncProgressEvent) => {
      setIsSyncing(event.inProgress);

      if (!event.inProgress) {
        // Drain finished — refresh pending count
        getSyncQueueCount()
          .then(setPendingCount)
          .catch(() => {});

        if (event.failed > 0) {
          setLastSyncError(
            `${event.failed} of ${event.total} offline action${event.total !== 1 ? 's' : ''} could not be synced and were dropped.`,
          );
        } else {
          setLastSyncError(null);
        }

        acknowledgeReconnect();
      }
    });

    return unsubscribe;
  }, [acknowledgeReconnect]);

  // Trigger a drain when we come back online
  useEffect(() => {
    if (isOnline) {
      engineRef.current.drain().catch((err) => {
        console.error('[useOfflineSync] Drain failed:', err);
        setLastSyncError('Failed to sync offline changes. Will retry on next reconnect.');
        setIsSyncing(false);
      });
    }
  }, [isOnline]);

  return { isOnline, isSyncing, pendingCount, lastSyncError };
}
