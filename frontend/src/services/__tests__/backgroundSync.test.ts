// ============================================================
// Tests for BackgroundSyncService
// ============================================================

import { BackgroundSyncService, OfflineQueuedError } from '../backgroundSync';

// ── Mock indexedDB (not provided by jsdom in this setup) ─────────────────────

const mockStore = {
  data: [] as Array<Record<string, unknown>>,
  nextId: 1,
};

const mockObjectStore = {
  add: jest.fn((entry: Record<string, unknown>) => {
    const id = mockStore.nextId++;
    const record = { ...entry, id };
    mockStore.data.push(record);
    const req = { onsuccess: null as ((e: { target: { result: number } }) => void) | null, onerror: null };
    setTimeout(() => req.onsuccess?.({ target: { result: id } }), 0);
    return req;
  }),
  getAll: jest.fn(() => {
    const req = { onsuccess: null as ((e: { target: { result: typeof mockStore.data } }) => void) | null, onerror: null };
    setTimeout(() => req.onsuccess?.({ target: { result: [...mockStore.data] } }), 0);
    return req;
  }),
  delete: jest.fn(() => {
    const req = { onsuccess: null as (() => void) | null, onerror: null };
    setTimeout(() => req.onsuccess?.(), 0);
    return req;
  }),
  clear: jest.fn(() => {
    mockStore.data = [];
    const req = { onsuccess: null as (() => void) | null, onerror: null };
    setTimeout(() => req.onsuccess?.(), 0);
    return req;
  }),
  createIndex: jest.fn(),
};

const mockTransaction = {
  objectStore: jest.fn(() => mockObjectStore),
};

const mockDB = {
  transaction: jest.fn(() => mockTransaction),
  objectStoreNames: { contains: jest.fn(() => false) },
  createObjectStore: jest.fn(() => mockObjectStore),
};

Object.defineProperty(global, 'indexedDB', {
  value: {
    open: jest.fn(() => {
      const req = {
        result: mockDB,
        onsuccess: null as (() => void) | null,
        onerror: null,
        onupgradeneeded: null as ((e: { target: { result: typeof mockDB } }) => void) | null,
      };
      setTimeout(() => {
        req.onupgradeneeded?.({ target: { result: mockDB } });
        req.onsuccess?.();
      }, 0);
      return req;
    }),
  },
  writable: true,
  configurable: true,
});

// ── BackgroundSyncService tests ───────────────────────────────────────────────

describe('BackgroundSyncService', () => {
  let service: BackgroundSyncService;

  beforeEach(() => {
    mockStore.data = [];
    mockStore.nextId = 1;
    jest.clearAllMocks();
    service = new BackgroundSyncService();
  });

  describe('OfflineQueuedError', () => {
    it('carries the queue id and a user-friendly message', () => {
      const err = new OfflineQueuedError(42);
      expect(err.name).toBe('OfflineQueuedError');
      expect(err.queueId).toBe(42);
      expect(err.message).toMatch(/42/);
    });
  });

  describe('onSyncResult / listener management', () => {
    it('calls registered listeners with the payload', () => {
      const listener = jest.fn();
      const unsub = service.onSyncResult(listener);

      (service as unknown as { listeners: Set<typeof listener> }).listeners.forEach(
        (cb) => cb({ id: 1, status: 'synced' as const, url: '/api/bets' }),
      );

      expect(listener).toHaveBeenCalledWith({ id: 1, status: 'synced', url: '/api/bets' });

      unsub();

      (service as unknown as { listeners: Set<typeof listener> }).listeners.forEach(
        (cb) => cb({ id: 2, status: 'synced' as const, url: '/api/bets' }),
      );

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('fetchWithSync', () => {
    it('returns the response when the fetch succeeds', async () => {
      const mockResponse = { ok: true, status: 200 } as Response;
      global.fetch = jest.fn().mockResolvedValueOnce(mockResponse);

      const response = await service.fetchWithSync('/api/test', { method: 'POST', body: '{}' });
      expect(response.status).toBe(200);
    });

    it('throws the original error for GET failures (not queued)', async () => {
      global.fetch = jest.fn().mockRejectedValueOnce(new Error('Network down'));

      await expect(service.fetchWithSync('/api/test', { method: 'GET' })).rejects.toThrow(
        'Network down',
      );
    });
  });
});

export {};
