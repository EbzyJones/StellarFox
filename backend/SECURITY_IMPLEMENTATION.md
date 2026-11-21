# Security Implementation Guide

This document outlines the comprehensive security fixes implemented in the StellarFox backend.

## Overview of Security Fixes

### 1. API Authentication, Rate Limiting, CORS Configuration, and Input Validation

#### Authentication (Enhanced)
- **File**: `src/middleware/auth-enhanced.middleware.ts`
- **Features**:
  - JWT token validation with separate secrets for access, refresh, and password-reset tokens
  - Optional authentication support for public endpoints
  - API key authentication for third-party integrations
  - Webhook signature verification using HMAC-SHA256
  - Request context attachment for audit logging

#### Rate Limiting (Enhanced)
- **File**: `src/middleware/rate-limit.middleware.ts`
- **Features**:
  - Sliding window rate limiting using Redis
  - Per-IP, per-user, and global rate limit strategies
  - Configurable limits for different endpoint groups:
    - `/auth`: 10 requests/minute
    - `/api`: 60 requests/minute
    - `/api/oracle`: 10 requests/minute (stricter for sensitive endpoints)
    - `/api/admin`: 20 requests/minute
    - `/wallet/withdraw`: 5 requests/minute per user
  - Returns proper rate limit headers (RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset)

#### CORS Configuration (Enhanced)
- **File**: `src/config/cors.ts`
- **Features**:
  - Explicit origin allowlist from environment variable
  - Restricted HTTP methods (GET, POST, PUT, DELETE, OPTIONS)
  - Credentials support enabled
  - Preflight caching for 1 hour
  - Proper header exposure configuration

#### Input Validation (New)
- **File**: `src/middleware/input-validation.middleware.ts`
- **Features**:
  - Payload size validation (10MB limit)
  - Recursion depth limiting (20 levels)
  - Array length limiting (1000 items max)
  - String length limiting (10KB per field)
  - SQL injection pattern detection and blocking
  - XSS attack pattern detection and blocking
  - Path traversal attack detection and blocking
  - Email format validation
  - UUID format validation
  - URL format validation
  - Stellar address format validation
  - Automatic string sanitization (null byte removal, whitespace trimming)

### 2. Data Anonymization for PII, GDPR Compliance, and Privacy Controls

#### Privacy Service
- **File**: `src/services/privacy.service.ts`
- **Capabilities**:
  - **PII Detection and Anonymization**:
    - Email pattern detection and redaction
    - Phone number pattern detection and redaction
    - SSN pattern detection and redaction
    - Credit card pattern detection and redaction
    - IP address pattern detection and redaction
  
  - **GDPR Compliance**:
    - Right of Access: Export all user data with `exportUserData()`
    - Right to be Forgotten: Delete all user data with `deleteUserData()`
    - Right to Restrict Processing: Restrict processing with `restrictProcessing()`
    - Right to Portability: Export in structured format
  
  - **Privacy Preferences**:
    - Marketing emails opt-in/out
    - Analytics opt-in/out
    - Data sharing opt-in/out
    - Processing restriction flags
  
  - **Data Retention**:
    - Configurable retention policies via environment variables:
      - `USER_DATA_RETENTION_DAYS` (default: 2555 = 7 years)
      - `AUDIT_LOG_RETENTION_DAYS` (default: 3650 = 10 years)
      - `ACTIVITY_LOG_RETENTION_DAYS` (default: 365 = 1 year)
    - Automatic data purging based on retention policies

#### Usage Examples

```typescript
// Export user data (GDPR Right of Access)
const userData = await privacyService.exportUserData(userId);

// Delete user data (GDPR Right to be Forgotten)
await privacyService.deleteUserData(userId);

// Restrict processing
await privacyService.restrictProcessing(userId, 'Customer requested processing restriction');

// Update privacy preferences
await privacyService.updatePrivacyPreferences(userId, {
  marketing_emails_opt_in: false,
  analytics_opt_in: false,
});

// Anonymize data
const anonymized = privacyService.anonymizeObject(
  userData,
  { removeEmail: true, removePhone: true },
  ['ssn', 'creditCard']
);

// Purge expired data
await privacyService.purgeExpiredData();
```

### 3. Comprehensive Audit Logging with Tamper-Proof Storage

#### Audit Logger Service
- **File**: `src/services/audit-logger.service.ts`
- **Features**:
  - **Immutable Audit Trail**:
    - SHA-256 checksum for each entry
    - Cryptographic chain linking consecutive entries
    - Tamper detection through checksum verification
    - Integrity verification using `verifyIntegrity()`
  
  - **Audit Log Storage**:
    - Timestamp of operation
    - User ID responsible for operation
    - Action type (CREATE, UPDATE, DELETE, LOGIN, etc.)
    - Resource type and ID
    - Old and new values for change tracking
    - IP address and user agent
    - Success/failure status
    - Error messages for failed operations
  
  - **Query and Export**:
    - Filter by user, action, resource, date range
    - Export as JSON or CSV
    - Pagination support
    - Performance-optimized indices

#### Sensitive Operations Tracked

The following operations are automatically logged:
- User authentication (login, logout, registration)
- User permission changes
- Market creation, updates, resolution
- Bet placement and outcomes
- Dispute creation and resolution
- Admin actions
- Data exports and deletions
- Privacy restriction changes

#### Usage Examples

```typescript
// Log an operation
await auditLogger.log(
  userId,
  'MARKET_CREATED',
  'market',
  marketId,
  {
    newValues: { title, status: 'PENDING' },
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    status: 'success',
  }
);

// Verify chain integrity
const isValid = await auditLogger.verifyIntegrity();

// Retrieve audit logs
const logs = await auditLogger.getLogs({
  userId,
  action: 'MARKET_CREATED',
  startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Last 30 days
  limit: 100,
});

// Export for compliance
const csv = await auditLogger.exportAuditTrail({
  format: 'csv',
  startDate: complianceStartDate,
  endDate: complianceEndDate,
});
```

### 4. Automated Security Testing with Penetration Testing and Vulnerability Assessment

#### Security Test Suite
- **File**: `tests/security/security-testing.ts`
- **Test Coverage**:
  - **Injection Attack Prevention**:
    - SQL injection attempts
    - XSS attack attempts
    - Path traversal attacks
    - Command injection attempts
  
  - **Authentication & Authorization**:
    - Unauthenticated access prevention
    - Invalid JWT token rejection
    - Expired token rejection
    - Role-based access control enforcement
  
  - **Rate Limiting**:
    - Per-IP rate limiting
    - Per-user rate limiting
    - Proper rate limit headers
  
  - **CORS Configuration**:
    - Unauthorized origin rejection
    - Authorized origin acceptance
    - Sensitive header exposure prevention
  
  - **Input Validation**:
    - Payload size limiting
    - Email format validation
    - UUID format validation
    - HTML sanitization
  
  - **Password Security**:
    - Complexity requirements enforcement
    - Sensitive data not exposed in logs
  
  - **Cryptography**:
    - HTTPS enforcement in production
    - Strong password hashing (bcrypt)
  
  - **Sensitive Data Exposure**:
    - PII redaction in errors
    - Server header hiding
    - Sensitive data encryption at rest

#### Running Security Tests

```bash
# Run all security tests
npm run test tests/security/security-testing.ts

# Run specific test suite
npm run test -- --testNamePattern='Injection Attack Prevention'

# Run with coverage
npm run test -- --coverage tests/security/security-testing.ts
```

## Environment Configuration

### Required Environment Variables

```env
# Authentication
JWT_SECRET=<long-random-secret>
JWT_ACCESS_SECRET=<unique-access-token-secret>
JWT_REFRESH_SECRET=<unique-refresh-token-secret>
JWT_TEMP_SECRET=<unique-temp-token-secret>
JWT_RESET_SECRET=<unique-password-reset-secret>
JWT_EXPIRES_IN=15m
REFRESH_EXPIRES_IN=7d

# CORS
ALLOWED_ORIGINS=http://localhost:3000,https://app.example.com

# API Keys
API_KEY=<secure-api-key>
WEBHOOK_SECRET=<webhook-signing-secret>

# Privacy & Data Retention
USER_DATA_RETENTION_DAYS=2555
AUDIT_LOG_RETENTION_DAYS=3650
ACTIVITY_LOG_RETENTION_DAYS=365
```

## Integration Steps

### 1. Initialize Audit Logger on Startup

```typescript
import { auditLogger } from './services/audit-logger.service';

// In your application startup:
await auditLogger.initialize();
```

### 2. Add Middleware to Express App

```typescript
import { validateInputMiddleware, validateQueryParams, validateUrlParams } from './middleware/input-validation.middleware';
import { requireAuth, attachRequestContext, attachApiKeyForRateLimit } from './middleware/auth-enhanced.middleware';

// Add after body parser
app.use(validateInputMiddleware);
app.use(validateQueryParams);
app.use(validateUrlParams);

// Add auth context for audit logging
app.use(attachRequestContext);

// API key rate limiting
app.use(attachApiKeyForRateLimit);
```

### 3. Integrate Audit Logging in Controllers

```typescript
import { auditLogger } from '../services/audit-logger.service';

// In your controller
const oldValues = await getMarketData(marketId);

// ... perform update ...

const newValues = await getMarketData(marketId);

await auditLogger.log(
  req.userId,
  'MARKET_UPDATED',
  'market',
  marketId,
  {
    oldValues,
    newValues,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    status: 'success',
  }
);
```

### 4. Implement Privacy Endpoints

```typescript
import { privacyService } from '../services/privacy.service';

// GDPR Data Export Endpoint
router.get('/api/users/:userId/data-export', requireAuth, async (req, res) => {
  const data = await privacyService.exportUserData(req.userId);
  res.json(data);
});

// GDPR Right to be Forgotten
router.post('/api/users/:userId/delete-account', requireAuth, async (req, res) => {
  await privacyService.deleteUserData(req.userId);
  res.json({ message: 'Account deleted' });
});

// Privacy Preferences
router.put('/api/users/:userId/privacy-preferences', requireAuth, async (req, res) => {
  await privacyService.updatePrivacyPreferences(req.userId, req.body);
  res.json({ message: 'Privacy preferences updated' });
});
```

## Monitoring and Maintenance

### Verify Audit Log Integrity

```bash
# Add to your monitoring/cron jobs
curl http://localhost:3000/api/admin/audit-verify

# Or programmatically:
const isValid = await auditLogger.verifyIntegrity();
if (!isValid) {
  logger.error('Audit log integrity check FAILED');
  // Alert security team
}
```

### Purge Expired Data

```bash
# Schedule via cron job
0 2 * * * npm run task:purge-expired-data

# Or add to your cron service:
import { privacyService } from './services/privacy.service';

// Run daily at 2 AM
cron.schedule('0 2 * * *', async () => {
  await privacyService.purgeExpiredData();
});
```

### Export Audit Trail for Compliance

```bash
# Manual export
curl 'http://localhost:3000/api/admin/audit-export?format=csv&startDate=2024-01-01' \
  -H "Authorization: Bearer admin-token" \
  > audit-trail-2024.csv
```

## Security Best Practices

1. **Never commit secrets**: Use environment variables for all sensitive data
2. **Rotate tokens regularly**: Implement token rotation for long-running sessions
3. **Monitor audit logs**: Set up alerts for suspicious activity patterns
4. **Regular backups**: Maintain immutable backups of audit logs
5. **Review retention policies**: Periodically review and adjust data retention settings
6. **Test security**: Run security tests regularly, especially before deployments
7. **HTTPS enforcement**: Always use HTTPS in production
8. **Keep dependencies updated**: Regularly update all npm packages for security patches

## Compliance

This implementation helps meet requirements for:
- GDPR (General Data Protection Regulation)
- CCPA (California Consumer Privacy Act)
- SOC 2 Type II
- PCI DSS (if handling payment data)
- HIPAA (if applicable)

## Support and Escalation

For security incidents or vulnerabilities:
1. Document the issue with reproduction steps
2. Contact the security team immediately
3. Do not publicly disclose until patch is available
4. Run security tests to verify the fix

See `SECURITY.md` for detailed incident response procedures.
