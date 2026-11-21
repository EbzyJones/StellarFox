import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from '../utils/AppError';
import { getEnv } from '../config/env';
import { logger } from '../utils/logger';

const env = getEnv();

/**
 * Enhanced authentication middleware with token validation and session checks
 */
export interface AuthenticatedRequest extends Request {
  userId?: string;
  user?: {
    id: string;
    email?: string;
    role?: string;
  };
  token?: string;
  tokenType?: 'access' | 'refresh' | 'bearer';
}

/**
 * Extract and validate JWT token from Authorization header
 */
export function extractToken(req: Request): { token: string; type: string } | null {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return null;
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2) {
    return null;
  }

  const [scheme, token] = parts;

  if (!/^Bearer$/i.test(scheme)) {
    return null;
  }

  return { token, type: 'bearer' };
}

/**
 * Required authentication middleware
 * Validates JWT token and attaches user info to request
 */
export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  try {
    const tokenData = extractToken(req);

    if (!tokenData) {
      return next(AppError.unauthorized('Missing or invalid Authorization header'));
    }

    const secret = env.JWT_ACCESS_SECRET || env.JWT_SECRET;

    try {
      const decoded = jwt.verify(tokenData.token, secret) as any;

      if (!decoded.sub) {
        return next(AppError.unauthorized('Invalid token: missing user ID'));
      }

      req.userId = decoded.sub;
      req.token = tokenData.token;
      req.tokenType = 'access';

      // Attach user object for backwards compatibility
      (req as any).user = {
        id: decoded.sub,
        role: decoded.role,
      };

      next();
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        return next(AppError.unauthorized('Token expired'));
      }
      if (err instanceof jwt.JsonWebTokenError) {
        return next(AppError.unauthorized('Invalid token'));
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
}

/**
 * Optional authentication middleware
 * Validates JWT token if present, but doesn't require it
 */
export function optionalAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  try {
    const tokenData = extractToken(req);

    if (!tokenData) {
      return next();
    }

    const secret = env.JWT_ACCESS_SECRET || env.JWT_SECRET;

    try {
      const decoded = jwt.verify(tokenData.token, secret) as any;

      if (decoded.sub) {
        req.userId = decoded.sub;
        req.token = tokenData.token;
        req.tokenType = 'access';
        (req as any).user = {
          id: decoded.sub,
          role: decoded.role,
        };
      }
    } catch (err) {
      logger.debug(
        { error: err instanceof Error ? err.message : String(err) },
        'Failed to validate optional auth token'
      );
      // Silently continue if token is invalid in optional mode
    }

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * API Key authentication middleware
 * Validates API key from Authorization header or query parameter
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const apiKey =
    req.headers['x-api-key'] ||
    req.headers['api-key'] ||
    (req.query.api_key as string | undefined);

  if (!apiKey) {
    return next(AppError.unauthorized('API key is required'));
  }

  const validApiKey = env.API_KEY;

  if (!validApiKey || apiKey !== validApiKey) {
    logger.warn({ apiKey: apiKey.substring(0, 10) + '...' }, 'Invalid API key');
    return next(AppError.unauthorized('Invalid API key'));
  }

  (req as any).apiKeyAuth = true;
  next();
}

/**
 * Rate limit by API key instead of IP
 */
export function attachApiKeyForRateLimit(req: Request, res: Response, next: NextFunction): void {
  const apiKey =
    req.headers['x-api-key'] ||
    req.headers['api-key'] ||
    (req.query.api_key as string | undefined);

  if (apiKey) {
    // Hash the API key to avoid exposing it in metrics
    const crypto = require('crypto');
    (req as any).apiKeyHash = crypto
      .createHash('sha256')
      .update(apiKey as string)
      .digest('hex');
  }

  next();
}

/**
 * Verify request signature for webhook authenticity
 * Expects signature in X-Signature header and request body
 */
export function verifyRequestSignature(req: Request, res: Response, next: NextFunction): void {
  const signature = req.headers['x-signature'] as string | undefined;
  const body = JSON.stringify(req.body);
  const secret = env.WEBHOOK_SECRET;

  if (!signature || !secret) {
    return next(AppError.unauthorized('Invalid or missing signature'));
  }

  const crypto = require('crypto');
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  // Use constant-time comparison to prevent timing attacks
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    logger.warn({ endpoint: req.path }, 'Webhook signature verification failed');
    return next(AppError.unauthorized('Invalid signature'));
  }

  next();
}

/**
 * Attach request context for audit logging
 */
export function attachRequestContext(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  (req as any).context = {
    userId: req.userId,
    ipAddress: req.ip || req.socket.remoteAddress,
    userAgent: req.headers['user-agent'],
    timestamp: new Date(),
    correlationId: (req as any).correlationId,
  };

  next();
}
