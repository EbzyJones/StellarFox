jest.mock('../../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../src/config/env', () => ({ getEnv: jest.fn(() => ({ JOB_QUEUE_SCHEDULER_ENABLED: false })) }));
jest.mock('../../src/queue/registry', () => ({
  queueManager: {
    isEnabled: jest.fn(() => true),
    getQueue: jest.fn(),
    definition: jest.fn(() => ({ defaultJobOptions: { attempts: 2 } })),
  },
}));

import { getEnv } from '../../src/config/env';
import { queueManager } from '../../src/queue/registry';
import { registerScheduledJobs, resetSchedulerState, SCHEDULED_JOBS } from '../../src/queue/scheduler';

function addMock() {
  const add = jest.fn().mockResolvedValue({});
  (queueManager.getQueue as jest.Mock).mockReturnValue({ add });
  return add;
}

describe('scheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSchedulerState();
    (queueManager.isEnabled as jest.Mock).mockReturnValue(true);
    (getEnv as jest.Mock).mockReturnValue({ JOB_QUEUE_SCHEDULER_ENABLED: false });
  });

  it('defines 1 snapshot + 6 cleanup repeatable jobs', () => {
    expect(SCHEDULED_JOBS).toHaveLength(7);
    expect(SCHEDULED_JOBS.filter((j) => j.queue === 'snapshot')).toHaveLength(1);
    expect(SCHEDULED_JOBS.filter((j) => j.queue === 'cleanup')).toHaveLength(6);
  });

  it('registers nothing when the subsystem is disabled', async () => {
    (queueManager.isEnabled as jest.Mock).mockReturnValue(false);
    const add = addMock();
    await registerScheduledJobs();
    expect(add).not.toHaveBeenCalled();
  });

  it('registers nothing when the scheduler flag is off (default)', async () => {
    const add = addMock();
    await registerScheduledJobs();
    expect(add).not.toHaveBeenCalled();
  });

  it('registers every repeatable job with a stable jobId and cron pattern when enabled', async () => {
    (getEnv as jest.Mock).mockReturnValue({ JOB_QUEUE_SCHEDULER_ENABLED: true });
    const add = addMock();
    await registerScheduledJobs();

    expect(add).toHaveBeenCalledTimes(7);
    // Snapshot fires every minute.
    const snap = add.mock.calls.find((c) => c[0] === 'snapshot')!;
    expect(snap[1]).toEqual({});
    expect(snap[2]).toMatchObject({ jobId: 'snapshot:probability', repeat: { pattern: '* * * * *' } });

    // A cleanup task carries its task selector and a cron pattern.
    const sessions = add.mock.calls.find(
      (c) => c[2]?.jobId === 'cleanup:sessions',
    )!;
    expect(sessions[1]).toEqual({ task: 'sessions' });
    expect(sessions[2]).toMatchObject({ repeat: { pattern: '0 * * * *' } });

    // defaultJobOptions are merged into the repeatable add().
    expect(sessions[2]).toMatchObject({ attempts: 2 });
  });

  it('is idempotent across repeated calls', async () => {
    (getEnv as jest.Mock).mockReturnValue({ JOB_QUEUE_SCHEDULER_ENABLED: true });
    const add = addMock();
    await registerScheduledJobs();
    await registerScheduledJobs();
    expect(add).toHaveBeenCalledTimes(7);
  });

  it('continues registering the remaining jobs if one add fails', async () => {
    (getEnv as jest.Mock).mockReturnValue({ JOB_QUEUE_SCHEDULER_ENABLED: true });
    const add = jest.fn().mockRejectedValueOnce(new Error('redis down')).mockResolvedValue({});
    (queueManager.getQueue as jest.Mock).mockReturnValue({ add });

    await registerScheduledJobs();
    expect(add).toHaveBeenCalledTimes(7);
  });
});
