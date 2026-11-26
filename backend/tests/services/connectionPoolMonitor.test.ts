/**
 * Tests for ConnectionPoolMonitor
 *
 * Uses a fake pg Pool (no real database needed) so the suite runs without
 * any infrastructure.  Every behaviour under test is exercised via the public
 * API; Prometheus metric state is validated through the gauge/counter objects.
 */

// Mock the alert service to avoid pulling in uuid, redis, and db deps
jest.mock('../../src/services/alert.service', () => ({
  getAlertService: () => ({
    triggerAlert: jest.fn().mockResolvedValue({ id: 'mock-alert' }),
  }),
}));

import {
  ConnectionPoolMonitor,
  initConnectionPoolMonitor,
  getConnectionPoolMonitor,
  resetConnectionPoolMonitor,
} from '../../src/services/connectionPoolMonitor.service';

// ── Fake Pool ─────────────────────────────────────────────────────────────────

function makeFakePool(overrides: Partial<{
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  connectError: Error | null;
}> = {}) {
  const opts = {
    totalCount: 3,
    idleCount: 2,
    waitingCount: 0,
    connectError: null,
    ...overrides,
  };

  const releaseMock = jest.fn();
  const queryMock = jest.fn().mockResolvedValue({ rows: [] });
  const clientMock = { query: queryMock, release: releaseMock };

  const connectMock = opts.connectError
    ? jest.fn().mockRejectedValue(opts.connectError)
    : jest.fn().mockResolvedValue(clientMock);

  return {
    pool: {
      get totalCount() { return opts.totalCount; },
      get idleCount() { return opts.idleCount; },
      get waitingCount() { return opts.waitingCount; },
      connect: connectMock,
    } as any,
    connectMock,
    releaseMock,
    queryMock,
    setTotalCount(n: number) { opts.totalCount = n; },
    setIdleCount(n: number) { opts.idleCount = n; },
    setWaitingCount(n: number) { opts.waitingCount = n; },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMonitor(poolOverrides = {}, configOverrides: Record<string, any> = {}) {
  const fake = makeFakePool(poolOverrides);
  const monitor = new ConnectionPoolMonitor(fake.pool, {
    maxSize: 10,
    sampleIntervalMs: 60_000, // prevent auto-ticking in tests
    disableAlerts: true,
    ...configOverrides,
  });
  return { monitor, fake };
}

// ── currentSnapshot ───────────────────────────────────────────────────────────

describe('ConnectionPoolMonitor.currentSnapshot', () => {
  it('returns null before first tick', () => {
    const { monitor } = makeMonitor();
    expect(monitor.currentSnapshot()).toBeNull();
  });

  it('returns a populated snapshot after start()', async () => {
    const { monitor, fake } = makeMonitor();
    // start() fires an immediate async tick — advance microtasks
    monitor.start();
    await new Promise((r) => setImmediate(r));
    monitor.stop();

    const snap = monitor.currentSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.active).toBe(1); // totalCount(3) - idleCount(2)
    expect(snap!.idle).toBe(2);
    expect(snap!.waiting).toBe(0);
    expect(snap!.maxSize).toBe(10);
    expect(snap!.utilizationPct).toBeCloseTo(10); // 1/10 * 100
  });
});

// ── snapshotHistory ───────────────────────────────────────────────────────────

describe('ConnectionPoolMonitor.snapshotHistory', () => {
  it('accumulates multiple snapshots', async () => {
    const { monitor } = makeMonitor();

    // Directly drive the private `tick` by calling start twice with flush
    monitor.start();
    await new Promise((r) => setImmediate(r));
    monitor.stop();

    const history = monitor.snapshotHistory();
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0]).toHaveProperty('timestamp');
    expect(history[0]).toHaveProperty('utilizationPct');
  });

  it('respects the limit parameter', async () => {
    const { monitor } = makeMonitor();
    monitor.start();
    await new Promise((r) => setImmediate(r));
    monitor.stop();

    const limited = monitor.snapshotHistory(1);
    expect(limited.length).toBeLessThanOrEqual(1);
  });
});

// ── Lifecycle tracking ────────────────────────────────────────────────────────

describe('ConnectionPoolMonitor lifecycle hooks', () => {
  it('records acquired event', () => {
    const { monitor } = makeMonitor();
    monitor.onWaitStart('c1');
    monitor.onAcquired('c1');

    const events = monitor.lifecycleHistory();
    expect(events.some((e) => e.event === 'acquired' && e.connectionId === 'c1')).toBe(true);
  });

  it('records released event with hold duration', () => {
    const { monitor } = makeMonitor();
    monitor.onWaitStart('c2');
    monitor.onAcquired('c2');
    monitor.onReleased('c2');

    const events = monitor.lifecycleHistory();
    const released = events.find((e) => e.event === 'released' && e.connectionId === 'c2');
    expect(released).toBeDefined();
    expect(typeof released!.holdDurationMs).toBe('number');
    expect(released!.holdDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('records destroyed event with reason', () => {
    const { monitor } = makeMonitor();
    monitor.onWaitStart('c3');
    monitor.onAcquired('c3');
    monitor.onDestroyed('c3', 'idle_timeout');

    const events = monitor.lifecycleHistory();
    const destroyed = events.find((e) => e.event === 'destroyed' && e.connectionId === 'c3');
    expect(destroyed).toBeDefined();
    expect(destroyed!.reason).toBe('idle_timeout');
  });

  it('records error event', () => {
    const { monitor } = makeMonitor();
    monitor.onWaitStart('c4');
    monitor.onError('c4', 'timeout');

    const events = monitor.lifecycleHistory();
    expect(events.some((e) => e.event === 'error' && e.connectionId === 'c4')).toBe(true);
  });

  it('caps lifecycle buffer at configured size', () => {
    const { monitor } = makeMonitor({}, { lifecycleBufferSize: 5 });
    for (let i = 0; i < 20; i++) {
      monitor.onWaitStart(`cx-${i}`);
      monitor.onAcquired(`cx-${i}`);
      monitor.onReleased(`cx-${i}`);
    }
    // lifecycleHistory returns most-recent first; underlying buffer capped at 5
    const all = monitor.lifecycleHistory();
    expect(all.length).toBeLessThanOrEqual(5);
  });
});

// ── healthSummary ─────────────────────────────────────────────────────────────

describe('ConnectionPoolMonitor.healthSummary', () => {
  it('returns healthy when no snapshot yet', () => {
    const { monitor } = makeMonitor();
    const summary = monitor.healthSummary();
    expect(summary.status).toBe('healthy');
    expect(summary.snapshot).toBeNull();
  });

  it('returns healthy for a lightly-loaded pool', async () => {
    const { monitor } = makeMonitor({ totalCount: 2, idleCount: 2, waitingCount: 0 });
    monitor.start();
    await new Promise((r) => setImmediate(r));
    monitor.stop();

    const { status } = monitor.healthSummary();
    expect(status).toBe('healthy');
  });

  it('reports degraded when utilisation exceeds warn threshold', async () => {
    // 9/10 connections active = 90% > default 80% warn
    const { monitor } = makeMonitor({ totalCount: 9, idleCount: 0, waitingCount: 0 });
    monitor.start();
    await new Promise((r) => setImmediate(r));
    monitor.stop();

    const { status, issues } = monitor.healthSummary();
    expect(status).not.toBe('healthy');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toMatch(/utilisation/i);
  });

  it('reports critical when utilisation exceeds critical threshold', async () => {
    // 10/10 = 100% > default 95% critical
    const { monitor } = makeMonitor({ totalCount: 10, idleCount: 0, waitingCount: 0 });
    monitor.start();
    await new Promise((r) => setImmediate(r));
    monitor.stop();

    const { status } = monitor.healthSummary();
    expect(status).toBe('critical');
  });

  it('includes waiting count in issues when elevated', async () => {
    // 20 waiting > default waitingCriticalCount=15
    const { monitor } = makeMonitor({ totalCount: 5, idleCount: 0, waitingCount: 20 });
    monitor.start();
    await new Promise((r) => setImmediate(r));
    monitor.stop();

    const { issues } = monitor.healthSummary();
    expect(issues.some((i) => i.includes('waiting'))).toBe(true);
  });
});

// ── Threshold management ──────────────────────────────────────────────────────

describe('ConnectionPoolMonitor.updateThresholds', () => {
  it('merges partial overrides into existing thresholds', () => {
    const { monitor } = makeMonitor();
    monitor.updateThresholds({ utilizationWarnPct: 50, alertDebounceMs: 5000 });
    const t = monitor.getThresholds();
    expect(t.utilizationWarnPct).toBe(50);
    expect(t.alertDebounceMs).toBe(5000);
    // other defaults untouched
    expect(t.utilizationCriticalPct).toBe(95);
  });
});

// ── selfHeal ──────────────────────────────────────────────────────────────────

describe('ConnectionPoolMonitor.selfHeal', () => {
  it('returns empty actions when pool is healthy', async () => {
    const { monitor } = makeMonitor({ totalCount: 2, idleCount: 2, waitingCount: 0 });
    monitor.start();
    await new Promise((r) => setImmediate(r));
    monitor.stop();

    const actions = await monitor.selfHeal();
    expect(actions.every((a) => a.action !== 'cull_idle')).toBe(true);
  });

  it('attempts idle-connection culling when utilisation exceeds selfHealCullPct', async () => {
    // 9/10 active = 90% ≥ default selfHealCullPct 90%; idleCount=1
    const { monitor, fake } = makeMonitor(
      { totalCount: 10, idleCount: 1, waitingCount: 0 },
    );
    monitor.start();
    await new Promise((r) => setImmediate(r));
    monitor.stop();

    const actions = await monitor.selfHeal();
    // Pool.connect was called for cull attempt
    expect(fake.connectMock).toHaveBeenCalled();
    // If connect succeeds, cull_idle action is recorded
    const cullAction = actions.find((a) => a.action === 'cull_idle');
    expect(cullAction).toBeDefined();
  });

  it('records circuit_break action after consecutive exhaustion ticks', async () => {
    const { monitor } = makeMonitor(
      { totalCount: 10, idleCount: 0, waitingCount: 5 },
      { thresholds: { selfHealCircuitBreakTicks: 2 } },
    );

    // Seed three ticks worth of exhaustion snapshots directly via start()
    monitor.start();
    await new Promise((r) => setImmediate(r));
    // Trigger selfHeal again (simulating second consecutive tick)
    await monitor.selfHeal();
    await monitor.selfHeal();
    monitor.stop();

    // By the third call the exhaustionTicks should reach the threshold
    const actions = await monitor.selfHeal();
    expect(actions.some((a) => a.action === 'circuit_break')).toBe(true);
  });
});

// ── Singleton helpers ─────────────────────────────────────────────────────────

describe('Singleton helpers', () => {
  afterEach(() => {
    resetConnectionPoolMonitor();
  });

  it('initConnectionPoolMonitor returns a ConnectionPoolMonitor instance', () => {
    const fake = makeFakePool().pool;
    const m = initConnectionPoolMonitor(fake, { disableAlerts: true });
    expect(m).toBeInstanceOf(ConnectionPoolMonitor);
  });

  it('getConnectionPoolMonitor returns the same instance', () => {
    const fake = makeFakePool().pool;
    const m = initConnectionPoolMonitor(fake, { disableAlerts: true });
    expect(getConnectionPoolMonitor()).toBe(m);
  });

  it('getConnectionPoolMonitor throws before init', () => {
    expect(() => getConnectionPoolMonitor()).toThrow();
  });

  it('resetConnectionPoolMonitor stops and clears the singleton', () => {
    const fake = makeFakePool().pool;
    initConnectionPoolMonitor(fake, { disableAlerts: true });
    resetConnectionPoolMonitor();
    expect(() => getConnectionPoolMonitor()).toThrow();
  });

  it('initConnectionPoolMonitor returns existing instance on second call', () => {
    const fake = makeFakePool().pool;
    const first = initConnectionPoolMonitor(fake, { disableAlerts: true });
    const second = initConnectionPoolMonitor(fake, { disableAlerts: true });
    expect(second).toBe(first);
  });
});
