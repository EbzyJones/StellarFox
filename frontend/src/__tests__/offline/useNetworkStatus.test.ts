/**
 * Tests for useNetworkStatus hook.
 */

import { renderHook, act } from '@testing-library/react';
import { useNetworkStatus } from '../../hooks/useNetworkStatus';

describe('useNetworkStatus', () => {
  const originalNavigator = global.navigator;

  beforeEach(() => {
    // Start online
    Object.defineProperty(global.navigator, 'onLine', {
      value: true,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(global.navigator, 'onLine', {
      value: originalNavigator.onLine,
      writable: true,
      configurable: true,
    });
  });

  test('returns isOnline=true initially when navigator.onLine is true', () => {
    const { result } = renderHook(() => useNetworkStatus());
    expect(result.current.isOnline).toBe(true);
    expect(result.current.wasOffline).toBe(false);
  });

  test('updates isOnline to false on "offline" event', () => {
    const { result } = renderHook(() => useNetworkStatus());

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });

    expect(result.current.isOnline).toBe(false);
    expect(result.current.wasOffline).toBe(true);
  });

  test('updates isOnline to true on "online" event', () => {
    const { result } = renderHook(() => useNetworkStatus());

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    expect(result.current.isOnline).toBe(true);
    // wasOffline stays true until acknowledged
    expect(result.current.wasOffline).toBe(true);
  });

  test('acknowledgeReconnect clears wasOffline', () => {
    const { result } = renderHook(() => useNetworkStatus());

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    act(() => {
      result.current.acknowledgeReconnect();
    });

    expect(result.current.wasOffline).toBe(false);
  });
});
