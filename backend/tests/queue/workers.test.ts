// WorkerManager (consumer side) — mocks BullMQ's Worker as an EventEmitter so the
// completed/failed/stalled event wiring can be exercised without Redis.

jest.mock('bullmq', () => {
  const { EventEmitter } = require('events');
  return {
    Worker: jest.fn().mockImplementation(function (this: unknown, name: string, processor: unknown, opts: unknown) {
      const w = new EventEmitter();
      Object.assign(w, { name, processor, opts, close: jest.fn().mockResolvedValue(undefined) });
      return w;
    }),
    Queue: jest.fn().mockImplementation((name: string, opts: unknown) => ({
      name,
      opts,
      add: jest.fn(),
      getJobCounts: jest.fn(),
      getJobs: jest.fn(),
      getJob: jest.fn(),
      isPaused: jest.fn(),
      pause: jest.fn(),
      resume: jest.fn(),
      close: jest.fn(),
    })),
  };
});
jest.mock('../../src/queue/connection', () => ({
  getQueueConnection: jest.fn(() => ({ mock: true })),
  closeQueueConnections: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/queue/metrics', () => ({
  queueJobDuration: { labels: jest.fn(() => ({ observe: jest.fn() })) },
  queueJobsCompleted: { inc: jest.fn() },
  queueJobsFailed: { inc: jest.fn() },
  queueJobsStalled: { inc: jest.fn() },
  queueDepth: { set: jest.fn() },
  queuePaused: { set: jest.fn() },
}));
jest.mock('../../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/config/env', () => ({
  getEnv: jest.fn(() => ({
    JOB_QUEUE_ENABLED: true,
    JOB_QUEUE_CONCURRENCY: 4,
    JOB_QUEUE_MAX_RETRIES: 3,
    JOB_QUEUE_BACKOFF_MS: 2000,
    JOB_QUEUE_REMOVE_ON_COMPLETE: 100,
    JOB_QUEUE_REMOVE_ON_FAIL: 500,
    JOB_QUEUE_STALLED_INTERVAL_MS: 30000,
    JOB_QUEUE_MAX_STALLED_COUNT: 1,
    JOB_QUEUE_MAX_ACTIVE: 0,
    JOB_QUEUE_METRICS_ENABLED: false,
    JOB_QUEUE_SCHEDULER_ENABLED: false,
  })),
}));
// Mock the handler registry so workers.ts never loads the real service modules
// (some, e.g. MarketService, have pre-existing syntax issues unrelated to queues).
jest.mock('../../src/queue/handlers', () => ({
  HANDLERS: {
    export: jest.fn().mockResolvedValue({ rows: 1 }),
    email: jest.fn().mockResolvedValue(undefined),
    'email-blast': jest.fn().mockResolvedValue({ sent: 1, failed: 0 }),
    batch: jest.fn().mockResolvedValue({ processed: 1, succeeded: 1, failed: 0, failedIds: [] }),
    snapshot: jest.fn().mockResolvedValue({ recorded: 0 }),
    cleanup: jest.fn().mockResolvedValue({ task: 'sessions', deleted: 0 }),
  },
}));

import { EventEmitter } from 'events';
import { Worker } from 'bullmq';
import { logger } from '../../src/utils/logger';
import { queueJobsCompleted, queueJobsFailed, queueJobsStalled, queueJobDuration } from '../../src/queue/metrics';
import { workerManager } from '../../src/queue/workers';
import { JobName } from '../../src/queue/types';

/** Grab the mock Worker instances BullMQ created, in creation order. */
function workers(): (EventEmitter & { name: string; processor: (job: unknown) => Promise<unknown>; close: jest.Mock })[] {
  return (Worker as unknown as jest.Mock).mock.results.map((r) => r.value as any);
}

describe('WorkerManager', () => {
  beforeEach(() => {
    // Worker is a jest.fn whose mock.results accumulate across tests; reset so
    // each test counts only the workers it created.
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await workerManager.close();
  });

  it('starts one worker per queue with the configured concurrency', () => {
    workerManager.start();
    const ws = workers();
    expect(ws).toHaveLength(6);
    expect(ws.map((w) => w.name)).toEqual([
      JobName.Export, JobName.Email, JobName.EmailBlast, JobName.Batch, JobName.Snapshot, JobName.Cleanup,
    ]);
    for (const w of ws) {
      expect((w as any).opts.concurrency).toBe(4);
    }
  });

  it('does not start duplicate workers on repeated start calls', () => {
    workerManager.start();
    workerManager.start();
    expect(workers()).toHaveLength(6);
  });

  it('runs the handler through the worker processor and records duration', async () => {
    workerManager.start();
    const [exportWorker] = workers();
    const result = await exportWorker.processor({
      id: '1',
      name: 'export',
      data: { type: 'trades' },
      attemptsMade: 1,
      opts: { attempts: 3 },
    });
    // The export handler mock (in handlers/index) returns the real handler; the
    // processor returns whatever the handler resolves with.
    expect(result).toBeDefined();
    expect(queueJobDuration.labels).toHaveBeenCalledWith('export', 'export');
  });

  it('increments completed metric on the completed event', () => {
    workerManager.start();
    const [, emailWorker] = workers();
    emailWorker.emit('completed', { id: '1', name: 'email' });
    expect(queueJobsCompleted.inc).toHaveBeenCalledWith({ queue: 'email', job: 'email' });
  });

  it('warns (not errors) when a failed job still has retries left', () => {
    workerManager.start();
    const [exportWorker] = workers();
    exportWorker.emit('failed', { id: '1', name: 'export', attemptsMade: 1, opts: { attempts: 3 } }, new Error('boom'));
    expect(queueJobsFailed.inc).toHaveBeenCalledWith({ queue: 'export', job: 'export' });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ queue: 'export', jobId: '1' }), expect.any(String));
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ queue: 'export' }),
      expect.any(String),
    );
  });

  it('errors when a failed job has exhausted retries', () => {
    workerManager.start();
    const [exportWorker] = workers();
    exportWorker.emit('failed', { id: '1', name: 'export', attemptsMade: 3, opts: { attempts: 3 } }, new Error('boom'));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ queue: 'export', jobId: '1', attemptsMade: 3 }),
      expect.any(String),
    );
  });

  it('counts stalled jobs', () => {
    workerManager.start();
    const [exportWorker] = workers();
    exportWorker.emit('stalled', '1');
    expect(queueJobsStalled.inc).toHaveBeenCalledWith({ queue: 'export', job: 'export' });
  });

  it('ignores failed events with no job (job removed before processing)', () => {
    workerManager.start();
    const [exportWorker] = workers();
    exportWorker.emit('failed', null, new Error('x'));
    expect(queueJobsFailed.inc).not.toHaveBeenCalled();
  });

  it('gracefully closes every worker and clears its registry', async () => {
    workerManager.start();
    const ws = workers();
    await workerManager.close();
    for (const w of ws) {
      expect(w.close).toHaveBeenCalled();
    }
    expect(workerManager.has(JobName.Export)).toBe(false);
  });
});
