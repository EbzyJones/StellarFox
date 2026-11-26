import { Router, Request, Response, NextFunction } from 'express';
import { validateBody, validateQuery, validateParams } from '../api/middleware/validate';
import { requireAuth } from '../middleware/auth.middleware';
import { requireAdminJwt } from '../middleware/requireAdminJwt.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import {
  createWebhookGroup9BodySchema,
  webhookIdParamGroup9Schema,
  listDeliveriesGroup9QuerySchema,
  replayWebhookDeliveriesGroup9BodySchema,
  CreateWebhookGroup9Body,
  WebhookIdParamGroup9,
  ListDeliveriesGroup9Query,
  ReplayWebhookDeliveriesGroup9Body,
} from '../schemas/webhooksGroup9.schemas';
import * as webhookService from '../services/webhook.service';

const router = Router();

// ---------------------------------------------------------------------------
// Helper to extract userId set by the auth middleware
// ---------------------------------------------------------------------------
function userId(req: Request): string {
  return (req as unknown as { userId: string }).userId;
}

/**
 * @swagger
 * /api/v2/webhooks/subscriptions:
 *   post:
 *     summary: Register a new webhook subscription
 *     description: >
 *       Creates a subscription that will receive signed HTTPS POST requests
 *       for each subscribed event topic.  The secret you provide is used for
 *       HMAC-SHA256 request signing; it is never returned after this response.
 *       Verify inbound requests with the `X-StellarFox-Signature` header.
 *     tags: [Webhooks]
 */
router.post(
  '/subscriptions',
  rateLimit({ windowMs: 60_000, max: 15, keyBy: 'ip' }),
  requireAuth,
  validateBody(createWebhookGroup9BodySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as CreateWebhookGroup9Body;
      const subscription = await webhookService.createSubscription({
        userId: userId(req),
        url: body.url,
        secret: body.secret,
        topics: body.topics as webhookService.WebhookTopic[],
        description: body.description,
      });

      res.status(201).json({ success: true, data: subscription });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /api/v2/webhooks/subscriptions:
 *   get:
 *     summary: List webhook subscriptions for the authenticated user
 *     tags: [Webhooks]
 */
router.get(
  '/subscriptions',
  rateLimit({ windowMs: 60_000, max: 60, keyBy: 'ip' }),
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const subscriptions = await webhookService.listSubscriptions(userId(req));
      res.status(200).json({ success: true, data: subscriptions });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /api/v2/webhooks/subscriptions/{id}:
 *   delete:
 *     summary: Deactivate a webhook subscription
 *     tags: [Webhooks]
 */
router.delete(
  '/subscriptions/:id',
  rateLimit({ windowMs: 60_000, max: 30, keyBy: 'ip' }),
  requireAuth,
  validateParams(webhookIdParamGroup9Schema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params as unknown as WebhookIdParamGroup9;
      const deleted = await webhookService.deleteSubscription(id, userId(req));
      if (!deleted) {
        res.status(404).json({ success: false, message: 'Subscription not found or already disabled' });
        return;
      }
      res.status(200).json({ success: true, message: `Subscription ${id} disabled` });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /api/v2/webhooks/subscriptions/{id}/test:
 *   post:
 *     summary: Send a test ping to a webhook endpoint
 *     description: >
 *       Dispatches a synthetic `ping` event to verify that the endpoint is
 *       reachable and responding with a 2xx status code.
 *     tags: [Webhooks]
 */
router.post(
  '/subscriptions/:id/test',
  rateLimit({ windowMs: 60_000, max: 10, keyBy: 'ip' }),
  requireAuth,
  validateParams(webhookIdParamGroup9Schema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params as unknown as WebhookIdParamGroup9;
      const result = await webhookService.sendTestPing(id, userId(req));

      res.status(result.delivered ? 200 : 502).json({
        success: result.delivered,
        message: result.delivered ? 'Test ping delivered' : 'Endpoint returned a non-2xx response',
        data: {
          test_event_id: `evt-ping-${Date.now()}`,
          delivered: result.delivered,
          http_status_code: result.httpStatus,
          latency_ms: result.latencyMs,
          error: result.error,
          dispatched_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /api/v2/webhooks/deliveries:
 *   get:
 *     summary: Retrieve delivery logs for the authenticated user's webhooks
 *     description: >
 *       Returns paginated delivery records including attempt counts, HTTP
 *       status codes, error messages, and retry schedule.
 *     tags: [Webhooks]
 */
router.get(
  '/deliveries',
  rateLimit({ windowMs: 60_000, max: 60, keyBy: 'ip' }),
  requireAuth,
  validateQuery(listDeliveriesGroup9QuerySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const query = req.query as unknown as ListDeliveriesGroup9Query;
      const { page = 1, limit = 20 } = query;

      const { data, total } = await webhookService.listDeliveries({
        userId: userId(req),
        webhookId: query.webhook_id,
        status: query.status as webhookService.WebhookDelivery['status'] | undefined,
        page,
        limit,
      });

      res.status(200).json({
        success: true,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
        data,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * @swagger
 * /api/v2/webhooks/admin/replay:
 *   post:
 *     summary: Admin – batch replay failed webhook deliveries
 *     description: >
 *       Re-queues the specified delivery IDs for immediate re-dispatch.
 *       Only deliveries in `failed` or `exhausted` state are eligible.
 *     tags: [Webhooks]
 */
router.post(
  '/admin/replay',
  rateLimit({ windowMs: 60_000, max: 10, keyBy: 'ip' }),
  requireAdminJwt,
  validateBody(replayWebhookDeliveriesGroup9BodySchema),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = req.body as ReplayWebhookDeliveriesGroup9Body;
      const { queued, skipped } = await webhookService.replayDeliveries(body.delivery_ids);

      res.status(200).json({
        success: true,
        message: `Queued ${queued.length} deliveries for replay`,
        data: {
          queued,
          skipped,
          queued_at: new Date().toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
