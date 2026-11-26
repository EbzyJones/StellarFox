'use client';

/**
 * OfflineBanner — sticky notification bar shown when the user is offline,
 * syncing, or if a sync error occurred.
 *
 * States:
 *   offline   → amber bar: "You're offline. Changes will sync when reconnected."
 *   syncing   → blue bar: "Back online — syncing N pending change(s)…"
 *   error     → red bar:  error message with a dismiss button
 *   online    → nothing rendered
 */

import { useState, useEffect } from 'react';

export interface OfflineBannerProps {
  isOnline: boolean;
  isSyncing: boolean;
  pendingCount: number;
  lastSyncError: string | null;
}

export function OfflineBanner({
  isOnline,
  isSyncing,
  pendingCount,
  lastSyncError,
}: OfflineBannerProps): JSX.Element | null {
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  // Reset dismissed state when a new error arrives
  useEffect(() => {
    if (lastSyncError !== dismissedError) {
      setDismissedError(null);
    }
  }, [lastSyncError, dismissedError]);

  const showError = lastSyncError !== null && lastSyncError !== dismissedError;

  if (isOnline && !isSyncing && !showError) {
    return null;
  }

  // ── Offline ──────────────────────────────────────────────────────────────
  if (!isOnline) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 bg-amber-500 px-4 py-2 text-sm font-medium text-white shadow-md"
      >
        <span aria-hidden="true">⚡</span>
        You&apos;re offline.
        {pendingCount > 0 && (
          <span>
            {pendingCount} pending change{pendingCount !== 1 ? 's' : ''} will sync when
            reconnected.
          </span>
        )}
        {pendingCount === 0 && <span>Changes will sync when reconnected.</span>}
      </div>
    );
  }

  // ── Syncing ──────────────────────────────────────────────────────────────
  if (isSyncing) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-md"
      >
        <svg
          aria-hidden="true"
          className="h-4 w-4 animate-spin"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8v8H4z"
          />
        </svg>
        Back online — syncing
        {pendingCount > 0 ? ` ${pendingCount} pending change${pendingCount !== 1 ? 's' : ''}` : ' changes'}
        …
      </div>
    );
  }

  // ── Sync error ───────────────────────────────────────────────────────────
  if (showError) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between gap-2 bg-red-600 px-4 py-2 text-sm font-medium text-white shadow-md"
      >
        <span>⚠ {lastSyncError}</span>
        <button
          onClick={() => setDismissedError(lastSyncError)}
          aria-label="Dismiss sync error"
          className="ml-4 rounded bg-red-800 px-2 py-0.5 text-xs hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-white"
        >
          Dismiss
        </button>
      </div>
    );
  }

  return null;
}
