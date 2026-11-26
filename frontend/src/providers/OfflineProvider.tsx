'use client';

/**
 * OfflineProvider — makes offline/sync state available throughout the app.
 *
 * Wraps the component tree and renders the OfflineBanner.
 * Use the `useOfflineContext` hook to read state in any component.
 */

import { createContext, useContext, type ReactNode } from 'react';
import { useOfflineSync, type OfflineSyncState } from '../hooks/useOfflineSync';
import { OfflineBanner } from '../components/ui/OfflineBanner';

const OfflineContext = createContext<OfflineSyncState>({
  isOnline: true,
  isSyncing: false,
  pendingCount: 0,
  lastSyncError: null,
});

export function OfflineProvider({ children }: { children: ReactNode }): JSX.Element {
  const state = useOfflineSync();

  return (
    <OfflineContext.Provider value={state}>
      <OfflineBanner
        isOnline={state.isOnline}
        isSyncing={state.isSyncing}
        pendingCount={state.pendingCount}
        lastSyncError={state.lastSyncError}
      />
      {children}
    </OfflineContext.Provider>
  );
}

/**
 * Returns the current offline/sync state.
 * Must be called inside an OfflineProvider.
 */
export function useOfflineContext(): OfflineSyncState {
  return useContext(OfflineContext);
}
