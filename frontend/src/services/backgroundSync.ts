// ============================================================
// BANKERCHANGER — Background Sync Service
//
// Queues mutation requests (POST/PUT/DELETE) in IndexedDB when
// the user is offline. When the service worker fires a "sync"
// event, sw.js replays the queue. The SW posts SYNC_RESULT
// messages back so this service can notify the UI.
//
// Usage:
//   import { backgroundSync } from '@/services/backgroundSync';
//   await backgroundSync.enqueue('/api/bets', 'POST', headers, body);
// ============================================================

export type SyncStatus = 'pending' | 'synced' | 'failed';

export interface SyncQueueEntry {
  id?: number;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  timestamp: number;
  tag: string;
  status: SyncStatus;
}

export interface SyncResultMessage {
  type: 'SYNC_RESULT';
  payload: {
    id: number;
    status: 'synced' | 'failed';
    url: string;
    statusCode?: number;
  };
}

type SyncResultListener = (payload: SyncResultMessage['payload']) => void;

const DB_NAME = 'bankerchanger-sync';
const DB_VERSION = 1;
const STORE_NAME = 'queue';
const SYNC_TAG = 'bankerchanger-sync';

class BackgroundSyncService {
  private db: IDBDatabase | null = null;
  private listeners: Set<SyncResultListener> = new Set();
  private messageHandler: ((event: MessageEvent) => void) | null = null;

  // ── IndexedDB ──────────────────────────────────────────────

  private async getDB(): Promise<IDBDatabase> {
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          store.createIndex('by_status', 'status');
          store.createIndex('by_url', 'url');
        }
      };

      req.onsuccess = () => {
        this.db = req.result;
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
  }

  private async idbAdd(entry: Omit<SyncQueueEntry, 'id'>): Promise<number> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).add(entry);
      req.onsuccess = () => resolve(req.result as number);
      req.onerror = () => reject(req.error);
    });
  }

  private async idbGetAll(): Promise<SyncQueueEntry[]> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result as SyncQueueEntry[]);
      req.onerror = () => reject(req.error);
    });
  }

  private async idbDelete(id: number): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  private async idbClear(): Promise<void> {
    const db = await this.getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const req = tx.objectStore(STORE_NAME).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // ── Queue management ──────────────────────────────────────

  /**
   * Enqueue a mutation for background sync.
   *
   * @param url      Destination URL
   * @param method   HTTP method (POST, PUT, DELETE, PATCH)
   * @param headers  Request headers (plain object)
   * @param body     Serialized request body, or null
   * @param tag      Optional descriptor for the operation (e.g. 'place-bet')
   */
  async enqueue(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | null,
    tag = 'mutation',
  ): Promise<number> {
    if (typeof window === 'undefined') throw new Error('backgroundSync requires a browser context');

    const entry: Omit<SyncQueueEntry, 'id'> = {
      url,
      method: method.toUpperCase(),
      headers,
      body,
      timestamp: Date.now(),
      tag,
      status: 'pending',
    };

    const id = await this.idbAdd(entry);

    // Try to register with the SW — degrades gracefully when not supported.
    await this.requestSync();

    return id;
  }

  /** Request a sync via the Background Sync API if available. */
  async requestSync(): Promise<void> {
    if (typeof navigator === 'undefined') return;

    try {
      const reg = await navigator.serviceWorker?.ready;
      // `sync` is not on the standard type yet, so we cast.
      const syncManager = (reg as unknown as { sync?: { register: (tag: string) => Promise<void> } }).sync;
      if (syncManager) {
        await syncManager.register(SYNC_TAG);
      }
    } catch {
      // Background Sync not supported in this browser — the SW will still
      // attempt a replay the next time the page loads.
    }
  }

  /** Return all pending queue entries. */
  async getPendingEntries(): Promise<SyncQueueEntry[]> {
    const all = await this.idbGetAll();
    return all.filter((e) => e.status === 'pending');
  }

  /** Return the count of pending entries. */
  async getPendingCount(): Promise<number> {
    const pending = await this.getPendingEntries();
    return pending.length;
  }

  /** Remove a specific entry from the queue. */
  async remove(id: number): Promise<void> {
    await this.idbDelete(id);
  }

  /** Clear the entire queue. */
  async clearQueue(): Promise<void> {
    await this.idbClear();
  }

  // ── SW message bridge ─────────────────────────────────────

  /**
   * Start listening for SYNC_RESULT messages from the service worker.
   * Safe to call multiple times — sets up the listener only once.
   */
  startListening(): void {
    if (typeof navigator === 'undefined' || this.messageHandler) return;

    this.messageHandler = (event: MessageEvent) => {
      const msg = event.data as SyncResultMessage;
      if (msg?.type === 'SYNC_RESULT') {
        this.listeners.forEach((cb) => cb(msg.payload));
      }
    };

    navigator.serviceWorker?.addEventListener('message', this.messageHandler);
  }

  /** Stop listening for SW messages. */
  stopListening(): void {
    if (!this.messageHandler) return;
    navigator.serviceWorker?.removeEventListener('message', this.messageHandler);
    this.messageHandler = null;
  }

  /**
   * Subscribe to sync result events.
   * Returns an unsubscribe function.
   */
  onSyncResult(listener: SyncResultListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── Convenience wrapper for fetch-with-fallback ───────────

  /**
   * Attempts a fetch. If it fails (network down), enqueues for
   * background sync and throws an OfflineQueuedError so callers
   * can show a user-friendly message.
   */
  async fetchWithSync(
    url: string,
    init: RequestInit & { tag?: string } = {},
  ): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();

    try {
      const response = await fetch(url, init);
      return response;
    } catch (error) {
      if (method === 'GET') throw error; // GET failures are not queued

      const headers: Record<string, string> = {};
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => { headers[key] = value; });
      } else if (init.headers && typeof init.headers === 'object') {
        Object.assign(headers, init.headers);
      }

      const body = typeof init.body === 'string' ? init.body : (init.body ? JSON.stringify(init.body) : null);
      const id = await this.enqueue(url, method, headers, body, init.tag);
      throw new OfflineQueuedError(id);
    }
  }
}

export class OfflineQueuedError extends Error {
  public readonly queueId: number;

  constructor(queueId: number) {
    super(`You are offline. This action has been queued (id: ${queueId}) and will complete when you reconnect.`);
    this.name = 'OfflineQueuedError';
    this.queueId = queueId;
  }
}

// Singleton — import this wherever you need background sync.
export const backgroundSync = new BackgroundSyncService();

// Also export the class for testing.
export { BackgroundSyncService };
