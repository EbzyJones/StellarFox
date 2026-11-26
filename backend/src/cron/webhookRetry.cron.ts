/**
 * Webhook retry cron
 *
 * Runs every 30 seconds and processes deliveries whose next_retry_at is due.
 * Uses node-cron's shortest supported interval (every minute) with a manual
 * 30-second stagger for the second run.
 */

import cron from 'node-cron';
import { logger } from '../utils/logger';
import { processRetries } from '../services/webhook.service';

export function startWebhookRetryCron(): void {
  if (process.env.WEBHOOK_RETRY_CRON_DISABLED === 'true') {
    logger.info('Webhook retry cron disabled via WEBHOOK_RETRY_CRON_DISABLED');
    return;
  }

  // Run at :00 of every minute.
  cron.schedule('* * * * *', async () => {
    try {
      await processRetries();
    } catch (err) {
      logger.error({ err }, 'webhookRetryCron: unhandled error');
    }
  });

  // Run at :30 of every minute.
  cron.schedule('* * * * *', async () => {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    try {
      await processRetries();
    } catch (err) {
      logger.error({ err }, 'webhookRetryCron: unhandled error (staggered)');
    }
  });

  logger.info('Webhook retry cron started (runs every ~30 s)');
}
