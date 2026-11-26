/**
 * Async Job Queue — Email handlers (long-running operations)
 *
 * Two job shapes share this file:
 *  - `email`: a single transactional email. Uses sendEmailStrict so SMTP errors
 *    throw and BullMQ retries with exponential backoff.
 *  - `email-blast`: many emails in one job, processed with bounded concurrency.
 *    Per-recipient failures are fanned back out as individual `email` jobs (which
 *    have their own retry budget) so a flaky recipient gets retried in isolation
 *    without re-sending the recipients that already succeeded.
 */

import { sendEmailStrict, type EmailTemplate } from '../../services/email.service';
import { logger } from '../../utils/logger';
import type { EmailBlastJobData, EmailBlastJobResult, EmailJobData } from '../types';
import { queueManager } from '../registry';
import { JobName } from '../types';
import type { HandlerJob } from './util';
import { mapWithConcurrency, withTimeout } from './util';

const EMAIL_TIMEOUT_MS = 60_000;
const BLAST_RECIPIENT_TIMEOUT_MS = 30_000;
/** Cap concurrency so a big blast doesn't open hundreds of SMTP connections at once. */
const BLAST_CONCURRENCY = 5;

/** Single email send. Throws on failure so the queue retries it. */
export async function handleEmailJob(job: HandlerJob<EmailJobData, void>): Promise<void> {
  const { to, template, data } = job.data;
  logger.info({ jobId: job.id, to, template }, 'Email job started');

  const { messageId } = await withTimeout(
    sendEmailStrict(to, template as EmailTemplate, data),
    EMAIL_TIMEOUT_MS,
    'email',
  );
  await job.log(`email sent to=${to} template=${template} messageId=${messageId}`);
  logger.info({ jobId: job.id, to, template, messageId }, 'Email job completed');
}

/** Bulk send with per-recipient progress; never throws (reports failures instead). */
export async function handleEmailBlastJob(
  job: HandlerJob<EmailBlastJobData, EmailBlastJobResult>,
): Promise<EmailBlastJobResult> {
  const { recipients } = job.data;
  const total = recipients.length;
  logger.info({ jobId: job.id, recipients: total }, 'Email blast started');
  await job.updateProgress({ sent: 0, failed: 0, total });

  let sent = 0;
  let failed = 0;
  const failedRecipients: EmailJobData[] = [];

  // Each recipient resolves to its messageId, or rejects (SMTP error / timeout).
  // mapWithConcurrency records the rejection as a 'rejected' outcome rather than
  // re-running the whole blast, so a flaky recipient is retried in isolation below.
  const outcomes = await mapWithConcurrency(recipients, BLAST_CONCURRENCY, async (r) => {
    const { messageId } = await withTimeout(
      sendEmailStrict(r.to, r.template as EmailTemplate, r.data),
      BLAST_RECIPIENT_TIMEOUT_MS,
      'email-blast',
    );
    return messageId;
  });

  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    if (o.status === 'fulfilled') {
      sent++;
    } else {
      failed++;
      failedRecipients.push(recipients[i]);
    }
    // Throttled-ish progress: update on every recipient so callers see live movement.
    await job.updateProgress({ sent, failed, total });
  }

  // Fan failed recipients back out as individual retryable email jobs. Each gets the
  // email queue's own attempts/backoff, so a transient SMTP blip is retried without
  // re-running the whole blast.
  if (failedRecipients.length > 0) {
    for (const r of failedRecipients) {
      try {
        await queueManager.enqueue(JobName.Email, r, { priority: 9 });
      } catch (err) {
        // Enqueue can fail only if the subsystem is disabled; log and move on.
        logger.warn({ err: (err as Error).message, to: r.to }, 'Failed to re-enqueue failed email');
      }
    }
    logger.warn({ jobId: job.id, failed: failedRecipients.length }, 'Email blast re-queued failures');
  }

  const result: EmailBlastJobResult = { sent, failed };
  logger.info({ jobId: job.id, sent, failed }, 'Email blast completed');
  return result;
}
