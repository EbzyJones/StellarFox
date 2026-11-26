/**
 * Tests for the IndexedDB-backed offline store.
 * Uses jest-environment-jsdom with a fake-indexeddb shim.
 */

// Polyfill IndexedDB for jsdom
import 'fake-indexeddb/auto';

import {
  cacheMarket,
  getCachedMarket,
  getAllCachedMarkets,
  evictCachedMarket,
  enqueueSync,
  getPendingSyncItems,
  removeSyncItem,
  updateSyncItemRetry,
  clearSyncQueue,
  getSyncQueueCount,
  type CachedMarket,
} from '../../services/offlineStore';

// Reset IDB state between tests
beforeEach(async () => {
  // Clear queues manually — fake-indexeddb persists across imports but not test files
  await clearSyncQueue();
  const cached = await getAllCachedMarkets();
  for (const m of cached) {
    await evictCachedMarket(m.market_id);
  }
});

// ---------------------------------------------------------------------------
// Market cache
// ---------------------------------------------------------------------------

describe('offlineStore — market cache', () => {
  const baseEntry: CachedMarket = {
    market_id: 'mkt-001',
    data: { market_id: 'mkt-001', fighter_a: 'Ali', fighter_b: 'Frazier' },
    serverUpdatedAt: 1_000_000,
    cachedAt: Date.now(),
  };

  test('stores and retrieves a market', async () => {
    await cacheMarket(baseEntry);
    const result = await getCachedMarket('mkt-001');
    expect(result).not.toBeNull();
    expect((result!.data as any).fighter_a).toBe('Ali');
  });

  test('returns null for a cache miss', async () => {
    const result = await getCachedMarket('nonexistent');
    expect(result).toBeNull();
  });

  test('server-wins: skips write when incoming data is older', async () => {
    await cacheMarket(baseEntry);

    const staleEntry: CachedMarket = {
      ...baseEntry,
      data: { market_id: 'mkt-001', fighter_a: 'STALE' },
      serverUpdatedAt: 500_000, // older than 1_000_000
    };
    await cacheMarket(staleEntry);

    const result = await getCachedMarket('mkt-001');
    // Should still have original "Ali"
    expect((result!.data as any).fighter_a).toBe('Ali');
  });

  test('server-wins: writes when incoming data is newer', async () => {
    await cacheMarket(baseEntry);

    const newerEntry: CachedMarket = {
      ...baseEntry,
      data: { market_id: 'mkt-001', fighter_a: 'Foreman' },
      serverUpdatedAt: 2_000_000, // newer
    };
    await cacheMarket(newerEntry);

    const result = await getCachedMarket('mkt-001');
    expect((result!.data as any).fighter_a).toBe('Foreman');
  });

  test('getAllCachedMarkets returns all stored entries', async () => {
    await cacheMarket(baseEntry);
    await cacheMarket({ ...baseEntry, market_id: 'mkt-002' });

    const all = await getAllCachedMarkets();
    expect(all.length).toBe(2);
  });

  test('evictCachedMarket removes the entry', async () => {
    await cacheMarket(baseEntry);
    await evictCachedMarket('mkt-001');
    const result = await getCachedMarket('mkt-001');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sync queue
// ---------------------------------------------------------------------------

describe('offlineStore — sync queue', () => {
  test('enqueues an item and retrieves it', async () => {
    const id = await enqueueSync('watchlist_add', { marketId: 'mkt-001', token: 'tok' });
    expect(typeof id).toBe('number');

    const items = await getPendingSyncItems();
    expect(items.length).toBe(1);
    expect(items[0].operation).toBe('watchlist_add');
    expect(items[0].retries).toBe(0);
    expect(items[0].lastAttemptAt).toBeNull();
  });

  test('enqueues multiple items in order', async () => {
    await enqueueSync('watchlist_add', { marketId: 'a' });
    await enqueueSync('watchlist_remove', { marketId: 'b' });

    const items = await getPendingSyncItems();
    expect(items[0].operation).toBe('watchlist_add');
    expect(items[1].operation).toBe('watchlist_remove');
  });

  test('removeSyncItem deletes the item', async () => {
    const id = await enqueueSync('watchlist_add', { marketId: 'mkt-x' });
    await removeSyncItem(id);
    const items = await getPendingSyncItems();
    expect(items).toHaveLength(0);
  });

  test('updateSyncItemRetry increments retries and sets lastAttemptAt', async () => {
    const id = await enqueueSync('feedback_submit', { input: { category: 'general', message: 'test' } });
    const before = Date.now();
    await updateSyncItemRetry(id, 1);
    const after = Date.now();

    const items = await getPendingSyncItems();
    expect(items[0].retries).toBe(1);
    expect(items[0].lastAttemptAt).toBeGreaterThanOrEqual(before);
    expect(items[0].lastAttemptAt).toBeLessThanOrEqual(after);
  });

  test('clearSyncQueue empties all items', async () => {
    await enqueueSync('watchlist_add', { marketId: 'a' });
    await enqueueSync('watchlist_add', { marketId: 'b' });
    await clearSyncQueue();
    const count = await getSyncQueueCount();
    expect(count).toBe(0);
  });

  test('getSyncQueueCount returns accurate count', async () => {
    expect(await getSyncQueueCount()).toBe(0);
    await enqueueSync('watchlist_add', { marketId: 'a' });
    await enqueueSync('watchlist_add', { marketId: 'b' });
    expect(await getSyncQueueCount()).toBe(2);
  });
});
