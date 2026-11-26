// QueueManager (producer side) — mocks BullMQ's Queue and the queue's own Redis
// connection / env / metrics so nothing touches a real Redis or Prometheus registry.

jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation((name: string, opts: unknown) => ({
    name,
    opts,
    add: jest.fn().mockResolvedValue({ id: 'job-x', name }),
    getJobCounts: jest
      .fn()
      .mockResolvedValue({ waiting: 1, active: 2, completed: 3, failed: 4, delayed: 5 }),
    getJobs: jest.fn().mockResolvedValue([{ id: 'j1', data: {}, returnvalue: null, attemptsMade: 1, opts: {}, name }]),
    getJob: jest.fn().mockResolvedValue(undefined),
    isPaused: jest.fn().mockResolvedValue(false),
    pause: jest.fn().mockResolvedValue(undefined),
    resume: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('../../src/queue/connection', () => ({
  getQueueConnection: jest.fn(() => ({ mock: true })),
  closeQueueConnections: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/queue/metrics', () => ({
  queueDepth: { set: jest.fn() },
  queuePaused: { set: jest.fn() },
  queueJobsCompleted: { inc: jest.fn() },
  queueJobsFailed: { inc: jest.fn() },
  queueJobsStalled: { inc: jest.fn() },
  queueJobDuration: { labels: jest.fn(() => ({ observe: jest.fn() })) },
}));
jest.mock('../../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const enabledEnv = {
  JOB_QUEUE_ENABLED: true,
  JOB_QUEUE_MAX_RETRIES: 3,
  JOB_QUEUE_BACKOFF_MS: 2000,
  JOB_QUEUE_REMOVE_ON_COMPLETE: 100,
  JOB_QUEUE_REMOVE_ON_FAIL: 500,
  JOB_QUEUE_CONCURRENCY: 4,
  JOB_QUEUE_STALLED_INTERVAL_MS: 30000,
  JOB_QUEUE_MAX_STALLED_COUNT: 1,
  JOB_QUEUE_MAX_ACTIVE: 0,
  JOB_QUEUE_METRICS_ENABLED: false,
  JOB_QUEUE_SCHEDULER_ENABLED: false,
};
jest.mock('../../src/config/env', () => ({ getEnv: jest.fn(() => enabledEnv) }));

import { Queue } from 'bullmq';
import { getEnv } from '../../src/config/env';
import { queuePaused } from '../../src/queue/metrics';
import { queueManager } from '../../src/queue/registry';
import { JobName, type ExportJobData } from '../../src/queue/types';

/** The QueueManager returns the (faked) BullMQ Queue instance it created, which
 *  exposes the jest.fn methods our bullmq mock attached. */
function fakeQueue(name: string): Record<string, jest.Mock> {
  return queueManager.getQueue(name) as unknown as Record<string, jest.Mock>;
}

describe('QueueManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // getEnv returns the enabled env by default; tests may override per-call.
    (getEnv as jest.Mock).mockImplementation(() => enabledEnv);
  });

  afterEach(async () => {
    // The QueueManager is a module singleton; clear its queue cache between tests
    // so has()/getAllStats assertions are independent.
    await queueManager.close();
  });

  it('exposes all configured queue names in definition order', () => {
    expect(queueManager.names()).toEqual([
      JobName.Export,
      JobName.Email,
      JobName.EmailBlast,
      JobName.Batch,
      JobName.Snapshot,
      JobName.Cleanup,
    ]);
  });

  it('lazily creates a queue and caches the instance', () => {
    const a = queueManager.getQueue(JobName.Export);
    const b = queueManager.getQueue(JobName.Export);
    expect(a).toBe(b);
    expect(Queue).toHaveBeenCalledTimes(1);
    expect(queueManager.has(JobName.Export)).toBe(true);
    expect(queueManager.has(JobName.Email)).toBe(false);
  });

  it('throws when the subsystem is disabled', () => {
    (getEnv as jest.Mock).mockImplementationOnce(() => ({ ...enabledEnv, JOB_QUEUE_ENABLED: false }));
    expect(() => queueManager.getQueue(JobName.Email)).toThrow(/disabled/);
  });

  it('enqueues a job and merges caller options over defaults', async () => {
    const data: ExportJobData = { type: 'trades' };
    const job = await queueManager.enqueue(JobName.Export, data, { priority: 1 });
    const q = fakeQueue(JobName.Export);
    expect(q.add).toHaveBeenCalledTimes(1);
    expect(job.id).toBe('job-x');
    // Caller priority override should reach add().
    const opts = q.add.mock.calls[0][2];
    expect(opts.priority).toBe(1);
    expect(opts.attempts).toBe(2); // export queue default (expensive → 2)
    expect(opts.backoff).toEqual({ type: 'exponential', delay: 2000 });
  });

  it('returns aggregate stats from getJobCounts + isPaused', async () => {
    const stats = await queueManager.getStats(JobName.Email);
    expect(stats).toEqual({
      name: JobName.Email,
      waiting: 1,
      active: 2,
      completed: 3,
      failed: 4,
      delayed: 5,
      paused: false,
    });
  });

  it('lists jobs via getJobs with start/end/types', async () => {
    const jobs = await queueManager.getJobs(JobName.Email, { start: 0, end: 9, types: ['failed'] });
    const q = fakeQueue(JobName.Email);
    expect(q.getJobs).toHaveBeenCalledWith(['failed'], 0, 9);
    expect(jobs).toHaveLength(1);
  });

  it('retries a failed job', async () => {
    const q = fakeQueue(JobName.Email);
    const job = { retry: jest.fn().mockResolvedValue(undefined) };
    q.getJob.mockResolvedValueOnce(job);
    await queueManager.retryJob(JobName.Email, 'abc');
    expect(job.retry).toHaveBeenCalled();
  });

  it('rejects retrying an unknown job', async () => {
    const q = fakeQueue(JobName.Email);
    q.getJob.mockResolvedValueOnce(undefined);
    await expect(queueManager.retryJob(JobName.Email, 'nope')).rejects.toThrow(/not found/);
  });

  it('removes a job', async () => {
    const q = fakeQueue(JobName.Email);
    const job = { remove: jest.fn().mockResolvedValue(undefined) };
    q.getJob.mockResolvedValueOnce(job);
    await queueManager.removeJob(JobName.Email, 'abc');
    expect(job.remove).toHaveBeenCalled();
  });

  it('pauses and resumes a queue, updating the paused gauge', async () => {
    await queueManager.pause(JobName.Email);
    expect(fakeQueue(JobName.Email).pause).toHaveBeenCalled();
    expect(queuePaused.set).toHaveBeenCalledWith({ queue: JobName.Email }, 1);

    await queueManager.resume(JobName.Email);
    expect(fakeQueue(JobName.Email).resume).toHaveBeenCalled();
    expect(queuePaused.set).toHaveBeenCalledWith({ queue: JobName.Email }, 0);
  });

  it('returns an overview for every queue, zero-filled for uninstantiated ones', async () => {
    queueManager.getQueue(JobName.Snapshot); // instantiate just one
    const overview = await queueManager.getAllStats();
    expect(overview).toHaveLength(6);
    const snap = overview.find((s) => s.name === JobName.Snapshot)!;
    expect(snap.waiting).toBe(1); // from the mocked getJobCounts
    const email = overview.find((s) => s.name === JobName.Email)!;
    expect(email.active).toBe(0); // uninstantiated → zeros
  });

  it('does not start the metrics poller when metrics are disabled', () => {
    queueManager.startMetricsPoller(10);
    // No queue should have been created as a side effect of polling setup.
    expect(queueManager.has(JobName.Batch)).toBe(false);
  });

  it('closes every queue and clears the cache', async () => {
    queueManager.getQueue(JobName.Batch);
    const q = fakeQueue(JobName.Batch);
    await queueManager.close();
    expect(q.close).toHaveBeenCalled();
    expect(queueManager.has(JobName.Batch)).toBe(false);
  });
});
