// ============================================================
// BANKERCHANGER — Offline Indicator
//
// A subtle banner that appears at the bottom of the screen
// whenever the browser goes offline. Also shows the count of
// mutations queued for background sync.
// ============================================================

'use client';

import { usePWA } from '../../hooks/usePWA';

export function OfflineIndicator(): JSX.Element | null {
  const { isOnline, pendingSyncCount } = usePWA();

  if (isOnline) return null;

  return (
    <div
      role="status"
      aria-live="assertive"
      className="fixed bottom-0 inset-x-0 z-40 flex items-center justify-center gap-2 bg-yellow-500/10 border-t border-yellow-500/30 px-4 py-2"
    >
      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-yellow-400 animate-pulse" />
      <p className="text-sm text-yellow-300 font-medium">
        You&apos;re offline
        {pendingSyncCount > 0 && (
          <span className="ml-1 text-yellow-400/80">
            — {pendingSyncCount} action{pendingSyncCount !== 1 ? 's' : ''} queued
          </span>
        )}
      </p>
    </div>
  );
}
