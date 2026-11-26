/**
 * Unit tests for webhook.service.ts
 *
 * All database interactions and outbound HTTP calls are mocked so the tests
 * run without a live database or network.
 */

import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Mock the pool so no real DB calls are made
// ---------------------------------------------------------------------------
const mockQuery = jest.fn();
jest.mock('../config/db', () => ({ pool: { query: mockQuery } }));

// ---------------------------------------------------------------------------
// Mock global fetch used by httpPost
// ---------------------------------------------------------------------------
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// Import after mocks are in place
// ---------------------------------------------------------------------------
import {
  createSubscription,
  listSubscriptions,
  deleteSubscription,
  listDeliveries,
  replayDeliveries,
  processRetries,
  dispatchEvent,
} from '../services/webhook.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSubRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'whk-test-0001',
    user_id: 'user-abc',
    url: 'https://example.com/hook',
    secret_hash: crypto.createHash('sha256').update('supersecret1234').digest('hex'),
    topics: ['market.resolved'],
    description: null,
    status: 'active',
    failure_count: 0,
    last_delivery_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function okResponse(status = 200) {
  return Promise.resolve({ status, ok: status >= 200 && status < 300 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

// ---- createSubscription ---------------------------------------------------

describe('createSubscription', () => {
  it('inserts a row and returns the subscription with a masked secret hint', async () => {
    // First query: INSERT; second query: SELECT
    mockQuery
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [makeSubRow()] });

    const result = await createSubscription({
      userId: 'user-abc',
      url: 'https://example.com/hook',
      secret: 'supersecret1234',
      topics: ['market.resolved'],
    });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    // INSERT should not contain the plaintext secret
    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[1]).not.toContain('supersecret1234');
    // The hash is stored
    const secretHash = crypto.createHash('sha256').update('supersecret1234').digest('hex');
    expect(insertCall[1]).toContain(secretHash);

    expect(result.secret_hint).toMatch(/^.{4}….{4}$/);
    expect(result.status).toBe('active');
  });
});

// ---- listSubscriptions ----------------------------------------------------

describe('listSubscriptions', () => {
  it('queries only non-disabled subscriptions for the user', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeSubRow()] });
    const result = await listSubscriptions('user-abc');
    expect(result).toHaveLength(1);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("status != 'disabled'");
    expect(mockQuery.mock.calls[0][1]).toEqual(['user-abc']);
  });
});

// ---- deleteSubscription ---------------------------------------------------

describe('deleteSubscription', () => {
  it('returns true when the subscription is found and updated', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    const ok = await deleteSubscription('whk-test-0001', 'user-abc');
    expect(ok).toBe(true);
  });

  it('returns false when no matching row exists', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    const ok = await deleteSubscription('whk-nonexistent', 'user-abc');
    expect(ok).toBe(false);
  });
});

// ---- listDeliveries -------------------------------------------------------

describe('listDeliveries', () => {
  it('returns paginated results scoped to the user', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '3' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'del-001' }, { id: 'del-002' }] });

    const result = await listDeliveries({ userId: 'user-abc', page: 1, limit: 2 });
    expect(result.total).toBe(3);
    expect(result.data).toHaveLength(2);

    const countSql = mockQuery.mock.calls[0][0] as string;
    expect(countSql).toContain('ws.user_id = $1');
  });

  it('filters by status when provided', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'del-003', status: 'failed' }] });

    await listDeliveries({ userId: 'user-abc', status: 'failed', page: 1, limit: 20 });

    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain('failed');
  });
});

// ---- replayDeliveries -----------------------------------------------------

describe('replayDeliveries', () => {
  it('queues eligible deliveries and skips ineligible ones', async () => {
    const deliveryRow = {
      id: 'del-001',
      webhook_id: 'whk-test-0001',
      event_type: 'market.resolved',
      payload: { event_type: 'market.resolved', data: {} },
      status: 'exhausted',
    };

    // del-001: found + subscription active
    // del-002: not found (empty rows)
    mockQuery
      .mockResolvedValueOnce({ rows: [deliveryRow] })                      // find del-001
      .mockResolvedValueOnce({ rows: [{ url: 'https://...', secret_hash: 'abc', status: 'active' }] }) // sub lookup
      .mockResolvedValueOnce({ rowCount: 1 })                              // UPDATE delivery
      .mockResolvedValueOnce({ rows: [] });                                // find del-002 → not found

    const result = await replayDeliveries(['del-001', 'del-002']);
    expect(result.queued).toEqual(['del-001']);
    expect(result.skipped).toEqual(['del-002']);
  });
});

// ---- processRetries -------------------------------------------------------

describe('processRetries', () => {
  it('dispatches retries for due deliveries', async () => {
    const dueDelivery = {
      id: 'del-retry-001',
      webhook_id: 'whk-test-0001',
      event_type: 'bet.placed',
      payload: { event_type: 'bet.placed', timestamp: new Date().toISOString(), data: { amount: 100 } },
      attempt_count: 1,
    };

    mockFetch.mockResolvedValueOnce(okResponse(200));

    // 1. SELECT due deliveries
    // 2. SELECT subscription (url + secret_hash)
    // 3. UPDATE delivery (success)
    // 4. UPDATE subscription (reset failure_count)
    mockQuery
      .mockResolvedValueOnce({ rows: [dueDelivery] })
      .mockResolvedValueOnce({ rows: [{ url: 'https://example.com/hook', secret_hash: 'testhash' }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    await processRetries();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchCall = mockFetch.mock.calls[0];
    expect(fetchCall[0]).toBe('https://example.com/hook');
    expect(fetchCall[1].method).toBe('POST');

    // The success UPDATE should set status = 'success'
    const successUpdateCall = mockQuery.mock.calls[2];
    expect(successUpdateCall[0]).toContain("status = 'success'");
  });

  it('schedules a retry when the endpoint returns 500', async () => {
    const dueDelivery = {
      id: 'del-retry-002',
      webhook_id: 'whk-test-0001',
      event_type: 'market.created',
      payload: { event_type: 'market.created', timestamp: new Date().toISOString(), data: {} },
      attempt_count: 2,
    };

    mockFetch.mockResolvedValueOnce(okResponse(500));

    mockQuery
      .mockResolvedValueOnce({ rows: [dueDelivery] })
      .mockResolvedValueOnce({ rows: [{ url: 'https://example.com/hook', secret_hash: 'testhash' }] })
      .mockResolvedValueOnce({ rowCount: 1 })  // UPDATE delivery → retrying
      .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE subscription failure_count

    await processRetries();

    const retryUpdateCall = mockQuery.mock.calls[2];
    expect(retryUpdateCall[0]).toContain("status = 'retrying'");
    // next_retry_at should be set (non-null param)
    expect(retryUpdateCall[1][3]).not.toBeNull();
  });

  it('marks delivery exhausted after MAX_ATTEMPTS', async () => {
    const dueDelivery = {
      id: 'del-retry-003',
      webhook_id: 'whk-test-0001',
      event_type: 'dispute.opened',
      payload: { event_type: 'dispute.opened', timestamp: new Date().toISOString(), data: {} },
      // attempt_count = 5, so this call becomes attempt 6 = MAX_ATTEMPTS
      attempt_count: 5,
    };

    mockFetch.mockResolvedValueOnce(okResponse(503));

    mockQuery
      .mockResolvedValueOnce({ rows: [dueDelivery] })
      .mockResolvedValueOnce({ rows: [{ url: 'https://example.com/hook', secret_hash: 'testhash' }] })
      .mockResolvedValueOnce({ rowCount: 1 })  // UPDATE delivery → exhausted
      .mockResolvedValueOnce({ rowCount: 1 }); // UPDATE subscription

    await processRetries();

    const exhaustedUpdateCall = mockQuery.mock.calls[2];
    expect(exhaustedUpdateCall[0]).toContain("status = 'exhausted'");
  });
});

// ---- dispatchEvent --------------------------------------------------------

describe('dispatchEvent', () => {
  it('sends a signed POST to every active subscriber for the topic', async () => {
    const sub1 = { id: 'whk-001', url: 'https://a.example.com/hook', secret_hash: 'hash1' };
    const sub2 = { id: 'whk-002', url: 'https://b.example.com/hook', secret_hash: 'hash2' };

    mockFetch.mockResolvedValue(okResponse(200));

    // findSubscriptions, then for each sub: INSERT delivery + UPDATE delivery + UPDATE sub
    mockQuery
      .mockResolvedValueOnce({ rows: [sub1, sub2] }) // find subscriptions
      // sub1
      .mockResolvedValueOnce({ rowCount: 1 })  // INSERT delivery
      .mockResolvedValueOnce({ rowCount: 1 })  // UPDATE delivery success
      .mockResolvedValueOnce({ rowCount: 1 })  // UPDATE subscription
      // sub2
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });

    await dispatchEvent('market.resolved', { market_id: 'mkt-123', outcome: 'fighter_a' });

    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Both calls should include the signature header
    for (const call of mockFetch.mock.calls) {
      expect(call[1].headers['X-StellarFox-Signature']).toMatch(/^sha256=/);
      expect(call[1].headers['X-StellarFox-Event-Id']).toMatch(/^evt-/);
    }
  });

  it('does nothing when no subscriptions match the topic', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await dispatchEvent('payout.distributed', { payout_id: 'pay-99' });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---- backoff / jitter -----------------------------------------------------

describe('exponential backoff', () => {
  it('schedules progressively later retries as failures accumulate', async () => {
    // Simulate 5 sequential failures and capture next_retry_at timestamps.
    const retryTimes: number[] = [];

    const dueDelivery = {
      id: 'del-backoff-01',
      webhook_id: 'whk-001',
      event_type: 'bet.placed',
      payload: { event_type: 'bet.placed', timestamp: new Date().toISOString(), data: {} },
      attempt_count: 0,
    };

    for (let attempt = 1; attempt <= 5; attempt++) {
      mockFetch.mockResolvedValueOnce(okResponse(500));
      mockQuery
        .mockResolvedValueOnce({ rows: [{ ...dueDelivery, attempt_count: attempt - 1 }] })
        .mockResolvedValueOnce({ rows: [{ url: 'https://example.com/h', secret_hash: 'h' }] })
        .mockImplementationOnce((_sql: string, params: unknown[]) => {
          // Capture next_retry_at (index 3 in the UPDATE params)
          retryTimes.push(new Date(params[3] as string).getTime());
          return Promise.resolve({ rowCount: 1 });
        })
        .mockResolvedValueOnce({ rowCount: 1 });

      await processRetries();
      mockQuery.mockClear();
      mockFetch.mockClear();
    }

    // Each retry should be scheduled further in the future than the previous.
    for (let i = 1; i < retryTimes.length; i++) {
      expect(retryTimes[i]).toBeGreaterThan(retryTimes[i - 1]);
    }
  });
});
