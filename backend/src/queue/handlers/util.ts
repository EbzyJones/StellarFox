/**
 * Async Job Queue — handler helpers
 *
 * Small utilities shared by job handlers so each handler stays focused on its
 * domain logic. Kept dependency-free so handlers remain trivial to unit-test.
 */

/**
 * Rejects with a timeout error if `promise` does not settle within `ms`.
 * BullMQ has no built-in per-job execution timeout, so handlers enforce their own
 * with this helper — same pattern already used by services/batchProcessor.service.ts.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Job "${label}" timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Run `fn` over every item with at most `concurrency` in flight, preserving input
 * order in the results. Resolves to a result array even if some items reject; each
 * entry is `{ status: 'fulfilled'|'rejected', value?, reason? }` like allSettled.
 */
export interface ConcurrencyOutcome<T> {
  status: 'fulfilled' | 'rejected';
  value?: T;
  reason?: unknown;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<ConcurrencyOutcome<R>[]> {
  const results: ConcurrencyOutcome<R>[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (err) {
        results[i] = { status: 'rejected', reason: err };
      }
    }
  }

  const workers: Promise<void>[] = [];
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  for (let w = 0; w < n; w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/** A minimal subset of BullMQ `Job` that handlers depend on. */
export interface HandlerJob<TData, TResult = unknown> {
  id: string;
  data: TData;
  attemptsMade: number;
  opts: { attempts?: number };
  updateProgress(value: number | object): Promise<void>;
  log(row: string): Promise<void>;
  returnvalue?: TResult;
}
