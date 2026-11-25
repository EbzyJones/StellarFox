import type { HandlerJob } from '../../src/queue/handlers/util';

// ---------------------------------------------------------------------------
// Mocks — keep handlers off the DB / SMTP / Redis. Each handler only depends on
// a few service functions, so we mock those modules rather than the handlers.
// ---------------------------------------------------------------------------

jest.mock('../../src/services/export.service', () => ({
  buildTradesCsv: jest.fn(),
  buildUserDataExport: jest.fn(),
  logExportAudit: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/services/email.service', () => ({ sendEmailStrict: jest.fn() }));
jest.mock('../../src/services/MarketService', () => ({ recordProbabilitySnapshots: jest.fn() }));
jest.mock('../../src/services/cron.service', () => ({
  deleteExpiredSessions: jest.fn(),
  deleteExpiredResetTokens: jest.fn(),
  deleteExpiredPredictions: jest.fn(),
  softDeleteOldNotifications: jest.fn(),
  archiveFailedDistributions: jest.fn(),
  cleanupOldBlockchainEvents: jest.fn(),
}));
jest.mock('../../src/config/redis', () => ({ redis: { setex: jest.fn().mockResolvedValue('OK'), get: jest.fn() } }));
jest.mock('../../src/config/env', () => ({ getEnv: jest.fn(() => ({ JOB_QUEUE_ENABLED: true })) }));
jest.mock('../../src/queue/registry', () => ({ queueManager: { enqueue: jest.fn().mockResolvedValue({ id: 'enq-1' }) } }));
jest.mock('../../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { redis } from '../../src/config/redis';
import { buildTradesCsv, buildUserDataExport, logExportAudit } from '../../src/services/export.service';
import { sendEmailStrict } from '../../src/services/email.service';
import { recordProbabilitySnapshots } from '../../src/services/MarketService';
import { deleteExpiredSessions } from '../../src/services/cron.service';
import { queueManager } from '../../src/queue/registry';
import { handleExportJob } from '../../src/queue/handlers/export.handler';
import { handleEmailJob, handleEmailBlastJob } from '../../src/queue/handlers/email.handler';
import { handleBatchJob, registerBatchProcessor } from '../../src/queue/handlers/batch.handler';
import { handleSnapshotJob } from '../../src/queue/handlers/snapshot.handler';
import { handleCleanupJob } from '../../src/queue/handlers/cleanup.handler';
import { JobName, type ExportJobData, type EmailJobData, type EmailBlastJobData, type BatchJobData, type SnapshotJobData, type CleanupJobData } from '../../src/queue/types';

function fakeJob<TData, TResult = unknown>(
  data: TData,
  extra: Partial<HandlerJob<TData, TResult>> = {},
): HandlerJob<TData, TResult> {
  return {
    id: 'job-1',
    data,
    attemptsMade: 1,
    opts: { attempts: 3 },
    updateProgress: jest.fn().mockResolvedValue(undefined),
    log: jest.fn().mockResolvedValue(undefined),
    ...extra,
  };
}

describe('queue handlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // sendEmailStrict gets persistent mockResolvedValue/mockRejectedValue in
    // different tests; reset and give it a resolving default so a prior test's
    // persistent rejection can never leak into the next.
    (sendEmailStrict as jest.Mock).mockReset();
    (sendEmailStrict as jest.Mock).mockResolvedValue({ messageId: 'default' });
  });

  // -------------------------------------------------------------------------
  describe('handleExportJob (long-running exports)', () => {
    it('builds a trades CSV, stashes it in Redis, and returns a summary', async () => {
      const csv = 'id,name\n1,a\n2,b\n';
      (buildTradesCsv as jest.Mock).mockResolvedValue(csv);

      const job = fakeJob<ExportJobData>({ type: 'trades', from: '2020-01-01', requestedBy: 'admin1' });
      const result = await handleExportJob(job);

      expect(buildTradesCsv).toHaveBeenCalledWith('2020-01-01', undefined);
      expect(redis.setex).toHaveBeenCalledWith(
        expect.stringContaining('queue:export:job-1:trades'),
        24 * 60 * 60,
        csv,
      );
      expect(logExportAudit).toHaveBeenCalledWith('admin1', 'trades', expect.objectContaining({ jobId: 'job-1', rows: 2 }));
      expect(result).toMatchObject({ type: 'trades', rows: 2, bytes: Buffer.byteLength(csv) });
      expect(result.location).toContain('queue:export:job-1:trades');
      expect(job.updateProgress).toHaveBeenCalledWith(0);
      expect(job.updateProgress).toHaveBeenCalledWith(100);
    });

    it('builds a userData export JSON and stashes it under a keyed location', async () => {
      const doc = { account: { id: 'u1' } };
      (buildUserDataExport as jest.Mock).mockResolvedValue(doc);

      const job = fakeJob<ExportJobData>({ type: 'userData', userId: 'u1' });
      const result = await handleExportJob(job);

      expect(buildUserDataExport).toHaveBeenCalledWith('u1');
      expect(redis.setex).toHaveBeenCalledWith(
        expect.stringContaining('queue:export:job-1:userData'),
        24 * 60 * 60,
        JSON.stringify(doc),
      );
      expect(result.rows).toBe(1);
    });

    it('throws when userData export is missing a userId', async () => {
      const job = fakeJob<ExportJobData>({ type: 'userData' });
      await expect(handleExportJob(job)).rejects.toThrow(/requires userId/);
    });

    it('throws on an unknown export type', async () => {
      const job = fakeJob<ExportJobData>({ type: 'unknown' as ExportJobData['type'] });
      await expect(handleExportJob(job)).rejects.toThrow(/Unknown export type/);
    });
  });

  // -------------------------------------------------------------------------
  describe('handleEmailJob (single email)', () => {
    it('sends via sendEmailStrict and resolves', async () => {
      (sendEmailStrict as jest.Mock).mockResolvedValue({ messageId: 'm1' });
      const job = fakeJob<EmailJobData>({ to: 'a@b.com', template: 'reset_password', data: { resetUrl: 'x' } });
      await handleEmailJob(job);
      expect(sendEmailStrict).toHaveBeenCalledWith('a@b.com', 'reset_password', { resetUrl: 'x' });
      expect(job.log).toHaveBeenCalledWith(expect.stringContaining('messageId=m1'));
    });

    it('propagates SMTP errors so the queue retries', async () => {
      (sendEmailStrict as jest.Mock).mockRejectedValue(new Error('smtp down'));
      const job = fakeJob<EmailJobData>({ to: 'a@b.com', template: 'reset_password', data: {} });
      await expect(handleEmailJob(job)).rejects.toThrow('smtp down');
    });
  });

  // -------------------------------------------------------------------------
  describe('handleEmailBlastJob (bulk email with fan-out retry)', () => {
    it('sends all recipients, reports progress, and re-enqueues failures as single email jobs', async () => {
      // Dispatch on the recipient address so the outcome is deterministic and not
      // dependent on once-queue ordering across tests.
      (sendEmailStrict as jest.Mock).mockImplementation(async (to: string) => {
        if (to === 'c@x.com') throw new Error('timeout');
        return { messageId: 'ok' };
      });

      const recipients: EmailJobData[] = [
        { to: 'a@x.com', template: 'market_resolved', data: {} },
        { to: 'b@x.com', template: 'market_resolved', data: {} },
        { to: 'c@x.com', template: 'market_resolved', data: {} },
      ];
      const job = fakeJob<EmailBlastJobData>({ recipients });
      const result = await handleEmailBlastJob(job);

      expect(result).toEqual({ sent: 2, failed: 1 });
      expect(sendEmailStrict).toHaveBeenCalledTimes(3);
      expect(queueManager.enqueue).toHaveBeenCalledTimes(1);
      expect(queueManager.enqueue).toHaveBeenCalledWith(
        JobName.Email,
        recipients[2],
        { priority: 9 },
      );
      // Progress should have advanced to the final counts.
      expect(job.updateProgress).toHaveBeenCalledWith({ sent: 2, failed: 1, total: 3 });
    });

    it('does not re-enqueue when every recipient succeeds', async () => {
      // beforeEach already made sendEmailStrict resolve by default.
      const job = fakeJob<EmailBlastJobData>({
        recipients: [{ to: 'a@x.com', template: 'market_resolved', data: {} }],
      });
      const result = await handleEmailBlastJob(job);
      expect(result).toEqual({ sent: 1, failed: 0 });
      expect(queueManager.enqueue).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('handleBatchJob (batch processing)', () => {
    it('processes every item with the registered processor and reports progress', async () => {
      registerBatchProcessor('double', async (payload: unknown) => (payload as number) * 2);
      const items = [
        { id: 'a', payload: 5 },
        { id: 'b', payload: 6 },
      ];
      const job = fakeJob<BatchJobData>({ items, processor: 'double' });
      const result = await handleBatchJob(job);

      expect(result).toEqual({ processed: 2, succeeded: 2, failed: 0, failedIds: [] });
      expect(job.updateProgress).toHaveBeenLastCalledWith({ processed: 2, succeeded: 2, failed: 0, total: 2 });
    });

    it('collects failed item ids without failing the whole job', async () => {
      registerBatchProcessor('flaky', async (payload: unknown) => {
        if (payload === 'bad') throw new Error('nope');
        return payload;
      });
      const items = [
        { id: 'ok1', payload: 'good' },
        { id: 'bad1', payload: 'bad' },
        { id: 'ok2', payload: 'good' },
      ];
      const job = fakeJob<BatchJobData>({ items, processor: 'flaky' });
      const result = await handleBatchJob(job);

      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.failedIds).toEqual(['bad1']);
    });

    it('throws for an unknown processor key', async () => {
      const job = fakeJob<BatchJobData>({ items: [], processor: 'no-such-processor' });
      await expect(handleBatchJob(job)).rejects.toThrow(/Unknown batch processor/);
    });
  });

  // -------------------------------------------------------------------------
  describe('handleSnapshotJob (scheduled)', () => {
    it('records snapshots and returns the count', async () => {
      (recordProbabilitySnapshots as jest.Mock).mockResolvedValue(42);
      const job = fakeJob<SnapshotJobData>({});
      const result = await handleSnapshotJob(job);
      expect(recordProbabilitySnapshots).toHaveBeenCalled();
      expect(result).toEqual({ recorded: 42 });
    });

    it('rejects when the underlying service fails so the scheduler retries', async () => {
      (recordProbabilitySnapshots as jest.Mock).mockRejectedValue(new Error('db down'));
      await expect(handleSnapshotJob(fakeJob<SnapshotJobData>({}))).rejects.toThrow('db down');
    });
  });

  // -------------------------------------------------------------------------
  describe('handleCleanupJob (scheduled)', () => {
    it('runs the selected task and returns the deleted count', async () => {
      (deleteExpiredSessions as jest.Mock).mockResolvedValue(7);
      const job = fakeJob<CleanupJobData>({ task: 'sessions' });
      const result = await handleCleanupJob(job);
      expect(deleteExpiredSessions).toHaveBeenCalled();
      expect(result).toEqual({ task: 'sessions', deleted: 7 });
    });

    it('throws for an unknown task', async () => {
      const job = fakeJob<CleanupJobData>({ task: 'nope' as CleanupJobData['task'] });
      await expect(handleCleanupJob(job)).rejects.toThrow(/Unknown cleanup task/);
    });
  });
});
