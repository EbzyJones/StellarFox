/**
 * SyncEngine — replays the offline sync queue when the network is restored.
 *
 * Conflict resolution strategy
 * ─────────────────────────────
 * • Market data (read-only from the user's perspective): server-wins.
 *   The offlineStore.cacheMarket() call already enforces this by comparing
 *   serverUpdatedAt timestamps.
 *
 * • User mutations (watchlist add/remove, feedback, bug reports): last-write-wins.
 *   Items are replayed in the order they were enqueued (FIFO). If an item fails
 *   with a non-retryable HTTP status (4xx), it is dropped. Transient failures
 *   (5xx, network errors) are retried up to MAX_RETRIES times with exponential
 *   back-off.
 *
 * Usage:
 *   const engine = SyncEngine.getInstance();
 *   engine.onProgress(cb);     // subscribe to progress events
 *   engine.drain();            // start draining the queue
 */

import {
  getPendingSyncItems,
  removeSyncItem,
  updateSyncItemRetry,
  type SyncQueueItem,
  type SyncOperationType,
} from './offlineStore';
import {
  addToWatchlist,
  removeFromWatchlist,
  submitFeedback,
  submitBugReport,
} from './api';

const MAX_RETRIES = 3;

export interface SyncProgressEvent {
  /** Total items in the queue at the start of this drain */
  total: number;
  /** Items successfully replayed so far */
  succeeded: number;
  /** Items that failed permanently and were dropped */
  failed: number;
  /** Whether the drain is still running */
  inProgress: boolean;
}

export type SyncProgressCallback = (event: SyncProgressEvent) => void;

// ---------------------------------------------------------------------------
// Payload types for each operation
// ---------------------------------------------------------------------------

interface WatchlistAddPayload {
  marketId: string;
  token: string;
}

interface WatchlistRemovePayload {
  marketId: string;
  token: string;
}

interface FeedbackPayload {
  input: {
    category: string;
    rating?: number;
    message: string;
    pageUrl?: string;
  };
  token?: string;
}

interface BugReportPayload {
  input: {
    title: string;
    description: string;
    severity?: string;
    category?: string;
    stepsToReproduce?: string;
    expectedBehavior?: string;
    actualBehavior?: string;
    pageUrl?: string;
    browserInfo?: Record<string, unknown>;
  };
  token?: string;
}

// ---------------------------------------------------------------------------
// SyncEngine
// ---------------------------------------------------------------------------

export class SyncEngine {
  private static _instance: SyncEngine | null = null;

  private progressCallbacks: Set<SyncProgressCallback> = new Set();
  private isDraining = false;

  private constructor() {}

  static getInstance(): SyncEngine {
    if (!SyncEngine._instance) {
      SyncEngine._instance = new SyncEngine();
    }
    return SyncEngine._instance;
  }

  /** Register a callback to receive progress events during a drain. */
  onProgress(cb: SyncProgressCallback): () => void {
    this.progressCallbacks.add(cb);
    return () => this.progressCallbacks.delete(cb);
  }

  private notify(event: SyncProgressEvent): void {
    this.progressCallbacks.forEach((cb) => cb(event));
  }

  /**
   * Replay all pending queue items in FIFO order.
   * Safe to call multiple times — concurrent drains are coalesced.
   */
  async drain(): Promise<void> {
    if (this.isDraining) return;
    this.isDraining = true;

    try {
      const items = await getPendingSyncItems();
      if (items.length === 0) {
        this.notify({ total: 0, succeeded: 0, failed: 0, inProgress: false });
        return;
      }

      let succeeded = 0;
      let failed = 0;
      const total = items.length;

      this.notify({ total, succeeded, failed, inProgress: true });

      for (const item of items) {
        const id = item.id!;

        // Exponential back-off: skip items that failed very recently
        if (item.lastAttemptAt !== null) {
          const backoffMs = Math.min(1000 * 2 ** item.retries, 30_000);
          if (Date.now() - item.lastAttemptAt < backoffMs) {
            continue;
          }
        }

        try {
          await this.replayItem(item);
          await removeSyncItem(id);
          succeeded++;
        } catch (err) {
          const retries = item.retries + 1;

          if (this.isNonRetryable(err) || retries >= MAX_RETRIES) {
            // Drop the item — further retries would not help
            await removeSyncItem(id);
            failed++;
            console.warn(
              `[SyncEngine] Dropped queue item ${id} (${item.operation}) after ${retries} attempts:`,
              err,
            );
          } else {
            await updateSyncItemRetry(id, retries);
          }
        }

        this.notify({ total, succeeded, failed, inProgress: true });
      }

      this.notify({ total, succeeded, failed, inProgress: false });
    } finally {
      this.isDraining = false;
    }
  }

  /** Whether a drain is currently running. */
  get running(): boolean {
    return this.isDraining;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async replayItem(item: SyncQueueItem): Promise<void> {
    const op = item.operation as SyncOperationType;

    switch (op) {
      case 'watchlist_add': {
        const p = item.payload as WatchlistAddPayload;
        await addToWatchlist(p.marketId, p.token);
        break;
      }

      case 'watchlist_remove': {
        const p = item.payload as WatchlistRemovePayload;
        await removeFromWatchlist(p.marketId, p.token);
        break;
      }

      case 'feedback_submit': {
        const p = item.payload as FeedbackPayload;
        await submitFeedback(p.input, p.token);
        break;
      }

      case 'bug_report_submit': {
        const p = item.payload as BugReportPayload;
        await submitBugReport(p.input, p.token);
        break;
      }

      default:
        throw new Error(`Unknown sync operation: ${op}`);
    }
  }

  /**
   * 4xx responses are non-retryable (bad data, auth failure, etc.).
   * 5xx and network errors are retryable.
   */
  private isNonRetryable(err: unknown): boolean {
    if (err instanceof Error) {
      // NetworkError wraps status codes like "Unexpected response: 400 ..."
      const match = err.message.match(/Unexpected response:\s*(\d{3})/);
      if (match) {
        const status = parseInt(match[1], 10);
        return status >= 400 && status < 500;
      }
      // NotFoundError is non-retryable
      if (err.name === 'NotFoundError') return true;
    }
    return false;
  }

  /** Reset the singleton (for tests). */
  static reset(): void {
    SyncEngine._instance = null;
  }
}
