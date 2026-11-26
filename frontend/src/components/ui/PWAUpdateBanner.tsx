// ============================================================
// BANKERCHANGER — PWA Update Banner
//
// Shown when a new service worker version is waiting. Gives the
// user a one-click way to reload and apply the update.
// ============================================================

'use client';

import { usePWA } from '../../hooks/usePWA';

export function PWAUpdateBanner(): JSX.Element | null {
  const { updateAvailable, applyUpdate } = usePWA();

  if (!updateAvailable) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-4 left-1/2 z-50 -translate-x-1/2 flex items-center gap-3 rounded-xl border border-blue-500/30 bg-gray-900 px-4 py-3 shadow-2xl"
    >
      <span className="text-sm text-gray-200">
        A new version of BANKERCHANGER is available.
      </span>
      <button
        type="button"
        onClick={applyUpdate}
        className="shrink-0 rounded-lg bg-blue-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-400 transition-colors"
      >
        Update now
      </button>
    </div>
  );
}
