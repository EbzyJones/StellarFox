import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

/**
 * Input validation and sanitization middleware
 * Prevents common injection attacks and malformed data
 */

// Maximum allowed sizes to prevent DoS
const LIMITS = {
  JSON_PAYLOAD: 10 * 1024 * 1024, // 10MB
  TEXT_FIELD: 10000, // 10KB per text field
  ARRAY_LENGTH: 1000,
  OBJECT_DEPTH: 20,
};

// Patterns for common injection attacks
const DANGEROUS_PATTERNS = {
  sql: /(\b(UNION|SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\b|--|;|\/\*|\*\/)/gi,
  xss: /(<script|<iframe|javascript:|onerror=|onload=|onclick=)/gi,
  pathTraversal: /\.\.\//g,
};

/**
 * Validate JSON payload size
 */
export function validatePayloadSize(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);

  if (contentLength > LIMITS.JSON_PAYLOAD) {
    return next(
      AppError.badRequest(
        `Payload size exceeds maximum allowed (${LIMITS.JSON_PAYLOAD} bytes)`
      )
    );
  }

  next();
}

/**
 * Sanitize string input to prevent injection attacks
 */
export function sanitizeString(input: string): string {
  let sanitized = input;

  // Remove null bytes
  sanitized = sanitized.replace(/\0/g, '');

  // Trim whitespace
  sanitized = sanitized.trim();

  return sanitized;
}

/**
 * Check for injection patterns in string
 */
export function detectInjectionAttempts(input: string): string | null {
  if (typeof input !== 'string') {
    return null;
  }

  for (const [type, pattern] of Object.entries(DANGEROUS_PATTERNS)) {
    if (pattern.test(input)) {
      return type;
    }
  }

  return null;
}

/**
 * Validate and sanitize object recursively
 */
export function validateAndSanitizeObject(
  obj: Record<string, any>,
  depth: number = 0
): Record<string, any> {
  if (depth > LIMITS.OBJECT_DEPTH) {
    throw AppError.badRequest('Object nesting too deep');
  }

  const sanitized: Record<string, any> = {};

  for (const [key, value] of Object.entries(obj)) {
    // Validate key
    if (key.length > LIMITS.TEXT_FIELD) {
      throw AppError.badRequest(`Field name too long: ${key.substring(0, 50)}...`);
    }

    const injectionType = detectInjectionAttempts(key);
    if (injectionType) {
      logger.warn(
        { field: key, injectionType },
        'Possible injection attempt detected in field name'
      );
      throw AppError.badRequest(`Invalid field name: potential ${injectionType} injection`);
    }

    // Validate and sanitize value
    if (typeof value === 'string') {
      if (value.length > LIMITS.TEXT_FIELD) {
        throw AppError.badRequest(`Field value too long: ${key}`);
      }

      const injectionType = detectInjectionAttempts(value);
      if (injectionType) {
        logger.warn(
          { field: key, injectionType },
          'Possible injection attempt detected in field value'
        );
        throw AppError.badRequest(
          `Invalid field value for ${key}: potential ${injectionType} injection`
        );
      }

      sanitized[key] = sanitizeString(value);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = value;
    } else if (value === null) {
      sanitized[key] = null;
    } else if (Array.isArray(value)) {
      if (value.length > LIMITS.ARRAY_LENGTH) {
        throw AppError.badRequest(
          `Array ${key} exceeds maximum length of ${LIMITS.ARRAY_LENGTH}`
        );
      }

      sanitized[key] = value.map((item) => {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          return validateAndSanitizeObject(item, depth + 1);
        }
        if (typeof item === 'string') {\n          return sanitizeString(item);
        }
        return item;
      });
    } else if (typeof value === 'object') {
      sanitized[key] = validateAndSanitizeObject(value, depth + 1);
    }
  }

  return sanitized;
}

/**
 * Input validation middleware for JSON payloads
 */
export function validateInputMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    // Only validate POST, PUT, PATCH requests with JSON bodies
    if (!['POST', 'PUT', 'PATCH'].includes(req.method)) {
      return next();
    }

    if (!req.body || typeof req.body !== 'object') {
      return next();
    }

    // Validate and sanitize body
    req.body = validateAndSanitizeObject(req.body);

    next();
  } catch (err) {
    if (err instanceof Error) {
      return next(AppError.badRequest(err.message));
    }
    next(err);
  }
}

/**
 * Validate query parameters
 */
export function validateQueryParams(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    for (const [key, value] of Object.entries(req.query)) {
      if (typeof value === 'string') {
        // Validate key
        const keyInjection = detectInjectionAttempts(key);
        if (keyInjection) {
          logger.warn(
            { param: key, injectionType: keyInjection },
            'Possible injection attempt in query parameter name'
          );
          throw AppError.badRequest(
            `Invalid query parameter: potential ${keyInjection} injection`
          );
        }

        // Validate value
        const valueInjection = detectInjectionAttempts(value);
        if (valueInjection) {
          logger.warn(
            { param: key, injectionType: valueInjection },
            'Possible injection attempt in query parameter value'
          );
          throw AppError.badRequest(
            `Invalid query parameter ${key}: potential ${valueInjection} injection`
          );
        }

        // Sanitize value
        req.query[key] = sanitizeString(value);
      }
    }

    next();
  } catch (err) {
    if (err instanceof Error) {
      return next(AppError.badRequest(err.message));
    }
    next(err);
  }
}

/**
 * Validate URL parameters
 */
export function validateUrlParams(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    for (const [key, value] of Object.entries(req.params)) {
      if (typeof value === 'string') {
        // Check for path traversal
        if (detectInjectionAttempts(value) === 'pathTraversal') {
          logger.warn({ param: key, value }, 'Path traversal attempt detected');
          throw AppError.badRequest(`Invalid parameter ${key}: path traversal detected`);
        }

        // Sanitize
        req.params[key] = sanitizeString(value);
      }
    }

    next();
  } catch (err) {
    if (err instanceof Error) {
      return next(AppError.badRequest(err.message));
    }
    next(err);
  }
}

/**
 * Validate email format
 */
export function validateEmail(email: string): boolean {
  const emailRegex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
  return emailRegex.test(email) && email.length <= 254;
}

/**
 * Validate URL format
 */
export function validateUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate UUID format
 */
export function validateUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Validate Stellar address format
 */
export function validateStellarAddress(address: string): boolean {
  // Stellar addresses start with 'G' and are 56 characters long (base32 encoded)
  const stellarRegex = /^G[A-Z2-7]{54}$/;
  return stellarRegex.test(address);
}
