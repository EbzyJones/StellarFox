/**
 * OfflineStore — IndexedDB-backed local-first data cache.
 *
 * Stores:
 *   - "markets"      keyed by market_id  (cached market data)
 *   - "sync_queue"   auto-increment key  (pending mutations to replay)
 *
 * No external dependencies — uses the native IDB API wrapped in Promises.
 */

export interface CachedMarket {
  market_id: string;
  data: unknown;
  /** Unix ms timestamp of the last server-authoritative write */
  serverUpdatedAt: number;
  /** Unix ms timestamp of when this cache entry was stored locally */
  cachedAt: number;
}

export type SyncOperationType =
  | 'watchlist_add'
  | 'watchlist_remove'
  | 'feedback_submit'
  | 'bug_report_submit';

export interface SyncQueueItem {
  /** Auto-increment primary key */
  id?: number;
  operation: SyncOperationType;
  /** Serialisable payload passed back to the original API call */
  payload: unknown;
  /** ISO-8601 timestamp when the item was enqueued */
  enqueuedAt: string;
  /** Number of replay attempts (incremented on each retry) */
  retries: number;
  /** Unix ms of last attempt, used for exponential back-off */
  lastAttemptAt: number | null;
}

const DB_NAME = 'stellarfox_offline';
const DB_VERSION = 1;
const STORE_MARKETS = 'markets';
const STORE_QUEUE = 'sync_queue';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains(STORE_MARKETS)) {
        db.createObjectStore(STORE_MARKETS, { keyPath: 'market_id' });
      }

      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: 'id', autoIncrement: true });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// Markets cache
// ---------------------------------------------------------------------------

/**
 * Persist a market to the local cache.
 * Implements server-wins conflict resolution: if the incoming `serverUpdatedAt`
 * is older than the stored entry, the write is silently skipped.
 */
export async function cacheMarket(entry: CachedMarket): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_MARKETS, 'readwrite');
  const store = tx.objectStore(STORE_MARKETS);

  const existing = await promisify<CachedMarket | undefined>(
    store.get(entry.market_id),
  );

  // Conflict resolution: skip stale incoming data
  if (existing && existing.serverUpdatedAt > entry.serverUpdatedAt) {
    db.close();
    return;
  }

  await promisify(store.put(entry));
  db.close();
}

/** Returns the cached market for the given id, or null if absent. */
export async function getCachedMarket(marketId: string): Promise<CachedMarket | null> {
  const db = await openDB();
  const tx = db.transaction(STORE_MARKETS, 'readonly');
  const store = tx.objectStore(STORE_MARKETS);
  const result = await promisify<CachedMarket | undefined>(store.get(marketId));
  db.close();
  return result ?? null;
}

/** Returns all cached markets (used to hydrate list views offline). */
export async function getAllCachedMarkets(): Promise<CachedMarket[]> {
  const db = await openDB();
  const tx = db.transaction(STORE_MARKETS, 'readonly');
  const store = tx.objectStore(STORE_MARKETS);
  const result = await promisify<CachedMarket[]>(store.getAll());
  db.close();
  return result;
}

/** Evict a single market from the cache. */
export async function evictCachedMarket(marketId: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_MARKETS, 'readwrite');
  const store = tx.objectStore(STORE_MARKETS);
  await promisify(store.delete(marketId));
  db.close();
}

// ---------------------------------------------------------------------------
// Sync queue
// ---------------------------------------------------------------------------

/** Enqueue a mutation to be replayed once the network is restored. */
export async function enqueueSync(
  operation: SyncOperationType,
  payload: unknown,
): Promise<number> {
  const db = await openDB();
  const tx = db.transaction(STORE_QUEUE, 'readwrite');
  const store = tx.objectStore(STORE_QUEUE);

  const item: SyncQueueItem = {
    operation,
    payload,
    enqueuedAt: new Date().toISOString(),
    retries: 0,
    lastAttemptAt: null,
  };

  const id = await promisify<IDBValidKey>(store.add(item));
  db.close();
  return id as number;
}

/** Returns all pending items in insertion order. */
export async function getPendingSyncItems(): Promise<SyncQueueItem[]> {
  const db = await openDB();
  const tx = db.transaction(STORE_QUEUE, 'readonly');
  const store = tx.objectStore(STORE_QUEUE);
  const result = await promisify<SyncQueueItem[]>(store.getAll());
  db.close();
  return result;
}

/** Update retry metadata after a failed attempt. */
export async function updateSyncItemRetry(
  id: number,
  retries: number,
): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_QUEUE, 'readwrite');
  const store = tx.objectStore(STORE_QUEUE);

  const existing = await promisify<SyncQueueItem | undefined>(store.get(id));
  if (!existing) {
    db.close();
    return;
  }

  await promisify(
    store.put({ ...existing, retries, lastAttemptAt: Date.now() }),
  );
  db.close();
}

/** Remove an item from the sync queue (after successful replay). */
export async function removeSyncItem(id: number): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_QUEUE, 'readwrite');
  const store = tx.objectStore(STORE_QUEUE);
  await promisify(store.delete(id));
  db.close();
}

/** Clear the entire sync queue (e.g. on logout). */
export async function clearSyncQueue(): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE_QUEUE, 'readwrite');
  const store = tx.objectStore(STORE_QUEUE);
  await promisify(store.clear());
  db.close();
}

/** Returns the number of items currently in the queue. */
export async function getSyncQueueCount(): Promise<number> {
  const db = await openDB();
  const tx = db.transaction(STORE_QUEUE, 'readonly');
  const store = tx.objectStore(STORE_QUEUE);
  const count = await promisify<number>(store.count());
  db.close();
  return count;
}
