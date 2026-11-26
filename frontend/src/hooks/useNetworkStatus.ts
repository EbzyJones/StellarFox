/**
 * useNetworkStatus — tracks browser online/offline state.
 *
 * Returns:
 *   isOnline   — current network reachability (from navigator.onLine)
 *   wasOffline — true from the moment the connection drops until the first
 *                successful reconnect drain completes; useful for showing
 *                "back online, syncing…" messages.
 */

import { useState, useEffect, useCallback } from 'react';

export interface NetworkStatus {
  isOnline: boolean;
  /** True when we just came back online and sync may still be in progress. */
  wasOffline: boolean;
  /** Reset wasOffline once sync is confirmed complete. */
  acknowledgeReconnect: () => void;
}

export function useNetworkStatus(): NetworkStatus {
  // SSR-safe: default to true (assume online until proved otherwise)
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [wasOffline, setWasOffline] = useState(false);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      // wasOffline stays true until acknowledgeReconnect is called
    };

    const handleOffline = () => {
      setIsOnline(false);
      setWasOffline(true);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const acknowledgeReconnect = useCallback(() => {
    setWasOffline(false);
  }, []);

  return { isOnline, wasOffline, acknowledgeReconnect };
}
