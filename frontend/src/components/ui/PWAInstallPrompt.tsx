// ============================================================
// BANKERCHANGER — PWA Install Prompt Banner
//
// Shows a dismissible install banner when the browser fires
// beforeinstallprompt. Respects a "dismissed" flag in
// localStorage so the banner doesn't reappear each session.
// ============================================================

'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePWA } from '../../hooks/usePWA';

const DISMISSED_KEY = 'bankerchanger_pwa_install_dismissed';

export function PWAInstallPrompt(): JSX.Element | null {
  const { isInstallable, promptInstall, isStandalone } = usePWA();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isInstallable || isStandalone) return;

    // Don't show if the user dismissed it previously.
    const dismissed = localStorage.getItem(DISMISSED_KEY);
    if (!dismissed) setVisible(true);
  }, [isInstallable, isStandalone]);

  const handleInstall = useCallback(async () => {
    const outcome = await promptInstall();
    if (outcome === 'accepted') {
      setVisible(false);
    }
  }, [promptInstall]);

  const handleDismiss = useCallback(() => {
    localStorage.setItem(DISMISSED_KEY, '1');
    setVisible(false);
  }, []);

  if (!visible) return null;

  return (
    <div
      role="banner"
      aria-label="Install BANKERCHANGER as an app"
      className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-sm rounded-xl border border-amber-400/30 bg-gray-900 p-4 shadow-2xl sm:left-auto sm:right-6 sm:bottom-6"
    >
      <div className="flex items-start gap-3">
        {/* Icon placeholder — replace with real icon once assets are present */}
        <div
          aria-hidden="true"
          className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-400 text-gray-950 font-black text-sm"
        >
          BK
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white">Install BANKERCHANGER</p>
          <p className="mt-0.5 text-xs text-gray-400">
            Add to your home screen for faster access and offline support.
          </p>
        </div>
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => void handleInstall()}
          className="flex-1 rounded-lg bg-amber-400 px-3 py-2 text-sm font-semibold text-gray-950 hover:bg-amber-300 transition-colors"
        >
          Install
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className="rounded-lg border border-gray-700 px-3 py-2 text-sm text-gray-400 hover:border-gray-500 hover:text-white transition-colors"
          aria-label="Dismiss install prompt"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
