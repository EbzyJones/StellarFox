// ============================================================
// BANKERCHANGER — usePWA hook
//
// Manages:
//   • Service worker registration and update detection
//   • PWA install prompt (beforeinstallprompt)
//   • Online/offline status
//   • Push notification permission
//   • Background sync pending count
// ============================================================

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { backgroundSync } from '../services/backgroundSync';

// Extend the standard BeforeInstallPromptEvent which is not in lib.dom.d.ts yet.
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt(): Promise<void>;
}

export interface PWAState {
  /** True once the SW is registered and active. */
  isInstalled: boolean;
  /** True if a new SW is waiting to take over. */
  updateAvailable: boolean;
  /** Whether the browser supports the install prompt. */
  isInstallable: boolean;
  /** Whether the app is currently running as an installed PWA. */
  isStandalone: boolean;
  /** Current online/offline state. */
  isOnline: boolean;
  /** Number of mutations queued for background sync. */
  pendingSyncCount: number;
  /** Push notification permission state. */
  notificationPermission: NotificationPermission;
  /** Call to trigger the install prompt. Resolves to the user's choice. */
  promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
  /** Activate the waiting SW immediately (skips waiting). */
  applyUpdate: () => void;
  /** Request push notification permission. */
  requestNotificationPermission: () => Promise<NotificationPermission>;
}

export function usePWA(): PWAState {
  const [isInstalled, setIsInstalled] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [isInstallable, setIsInstallable] = useState(false);
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default',
  );

  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);
  const swRegistrationRef = useRef<ServiceWorkerRegistration | null>(null);

  const isStandalone =
    typeof window !== 'undefined' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
      ('standalone' in window.navigator && (window.navigator as { standalone?: boolean }).standalone === true));

  // ── Service Worker registration ──────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    let mounted = true;

    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        if (!mounted) return;

        swRegistrationRef.current = registration;
        setIsInstalled(true);

        // A new SW is already waiting (page was reloaded before update applied).
        if (registration.waiting) {
          setUpdateAvailable(true);
        }

        // Listen for a new SW entering the waiting state.
        registration.addEventListener('updatefound', () => {
          const newWorker = registration.installing;
          if (!newWorker) return;

          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              if (mounted) setUpdateAvailable(true);
            }
          });
        });

        // Poll for updates every 60 s while the tab is visible.
        const updateInterval = setInterval(() => {
          if (!document.hidden) registration.update().catch(() => {});
        }, 60_000);

        return () => clearInterval(updateInterval);
      })
      .catch((err) => {
        console.warn('[SW] Registration failed:', err);
      });

    // When a new SW takes control, reload to get the fresh app shell.
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        refreshing = true;
        window.location.reload();
      }
    });

    return () => { mounted = false; };
  }, []);

  // ── Install prompt ────────────────────────────────────────
  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault();
      deferredPromptRef.current = event as BeforeInstallPromptEvent;
      setIsInstallable(true);
    };

    window.addEventListener('beforeinstallprompt', handler);
    window.addEventListener('appinstalled', () => {
      deferredPromptRef.current = null;
      setIsInstallable(false);
    });

    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  // ── Online / offline ──────────────────────────────────────
  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  // ── Background sync count ─────────────────────────────────
  useEffect(() => {
    let mounted = true;

    const refresh = async () => {
      const count = await backgroundSync.getPendingCount();
      if (mounted) setPendingSyncCount(count);
    };

    refresh();
    backgroundSync.startListening();

    const unsub = backgroundSync.onSyncResult(async () => {
      await refresh();
    });

    // Recount when coming back online.
    const onOnline = () => void refresh();
    window.addEventListener('online', onOnline);

    return () => {
      mounted = false;
      unsub();
      window.removeEventListener('online', onOnline);
    };
  }, []);

  // ── Actions ───────────────────────────────────────────────

  const promptInstall = useCallback(async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    if (!deferredPromptRef.current) return 'unavailable';
    await deferredPromptRef.current.prompt();
    const { outcome } = await deferredPromptRef.current.userChoice;
    deferredPromptRef.current = null;
    setIsInstallable(false);
    return outcome;
  }, []);

  const applyUpdate = useCallback(() => {
    const reg = swRegistrationRef.current;
    if (!reg?.waiting) return;
    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
  }, []);

  const requestNotificationPermission = useCallback(async (): Promise<NotificationPermission> => {
    if (typeof Notification === 'undefined') return 'denied';
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    return permission;
  }, []);

  return {
    isInstalled,
    updateAvailable,
    isInstallable,
    isStandalone,
    isOnline,
    pendingSyncCount,
    notificationPermission,
    promptInstall,
    applyUpdate,
    requestNotificationPermission,
  };
}
