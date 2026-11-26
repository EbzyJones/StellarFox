// ============================================================
// Tests for usePWA hook
// ============================================================

import { act, renderHook } from '@testing-library/react';
import { usePWA } from '../usePWA';

// ── Mock backgroundSync (avoids IDB dependency in hook tests) ─────────────────

jest.mock('../../services/backgroundSync', () => ({
  backgroundSync: {
    getPendingCount: jest.fn().mockResolvedValue(0),
    startListening: jest.fn(),
    stopListening: jest.fn(),
    onSyncResult: jest.fn().mockReturnValue(jest.fn()),
  },
  OfflineQueuedError: class OfflineQueuedError extends Error {
    queueId: number;
    constructor(id: number) { super(`queued ${id}`); this.queueId = id; }
  },
}));

// ── Minimal SW mock ───────────────────────────────────────────────────────────

const mockRegistration = {
  waiting: null as ServiceWorker | null,
  installing: null as ServiceWorker | null,
  addEventListener: jest.fn(),
  update: jest.fn().mockResolvedValue(undefined),
};

const mockServiceWorker = {
  register: jest.fn().mockResolvedValue(mockRegistration),
  ready: Promise.resolve(mockRegistration),
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
  controller: null,
};

beforeEach(() => {
  jest.clearAllMocks();

  Object.defineProperty(navigator, 'serviceWorker', {
    value: mockServiceWorker,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(navigator, 'onLine', {
    value: true,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: jest.fn().mockReturnValue({ matches: false }),
  });
});

describe('usePWA', () => {
  it('registers the service worker on mount', async () => {
    const { result } = renderHook(() => usePWA());

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockServiceWorker.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(result.current.isInstalled).toBe(true);
  });

  it('reports online status correctly', () => {
    const { result } = renderHook(() => usePWA());
    expect(result.current.isOnline).toBe(true);
  });

  it('updates isOnline when going offline', () => {
    const { result } = renderHook(() => usePWA());

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });

    expect(result.current.isOnline).toBe(false);

    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    expect(result.current.isOnline).toBe(true);
  });

  it('detects updateAvailable when waiting worker exists', async () => {
    (mockRegistration as unknown as { waiting: { state: string } }).waiting = { state: 'installed' };
    mockServiceWorker.controller = {} as ServiceWorker;

    const { result } = renderHook(() => usePWA());

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.updateAvailable).toBe(true);

    // Reset
    mockRegistration.waiting = null;
    (mockServiceWorker as unknown as { controller: null }).controller = null;
  });

  it('promptInstall returns unavailable when no prompt is queued', async () => {
    const { result } = renderHook(() => usePWA());
    const outcome = await result.current.promptInstall();
    expect(outcome).toBe('unavailable');
  });

  it('applyUpdate posts SKIP_WAITING to the waiting worker', async () => {
    const mockWaiting = { postMessage: jest.fn() };
    (mockRegistration as unknown as { waiting: typeof mockWaiting }).waiting = mockWaiting;

    const { result } = renderHook(() => usePWA());

    await act(async () => {
      await Promise.resolve();
    });

    result.current.applyUpdate();
    expect(mockWaiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });

    mockRegistration.waiting = null;
  });

  it('isStandalone is false in a normal browser context', () => {
    const { result } = renderHook(() => usePWA());
    expect(result.current.isStandalone).toBe(false);
  });
});
