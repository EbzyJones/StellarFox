import { withTimeout, mapWithConcurrency } from '../../src/queue/handlers/util';

describe('queue handler util', () => {
  describe('withTimeout', () => {
    it('returns the value when the promise resolves in time', async () => {
      await expect(withTimeout(Promise.resolve('ok'), 100, 'l')).resolves.toBe('ok');
    });

    it('returns the value immediately when ms <= 0 (no timeout enforced)', async () => {
      await expect(withTimeout(Promise.resolve('ok'), 0, 'l')).resolves.toBe('ok');
    });

    it('rejects with a timeout error when the promise never settles', async () => {
      jest.useFakeTimers();
      try {
        const p = withTimeout(new Promise<string>(() => {}), 1000, 'slow');
        jest.advanceTimersByTime(1000);
        await expect(p).rejects.toThrow(/slow.*timed out after 1000ms/);
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not leak the timer when the promise resolves first', async () => {
      const p = withTimeout(Promise.resolve('fast'), 50_000, 'l');
      await expect(p).resolves.toBe('fast');
    });
  });

  describe('mapWithConcurrency', () => {
    it('runs all items and preserves order in the results', async () => {
      const items = [1, 2, 3, 4, 5];
      const out = await mapWithConcurrency(items, 2, async (n) => n * 10);
      expect(out.map((o) => o.value)).toEqual([10, 20, 30, 40, 50]);
      expect(out.every((o) => o.status === 'fulfilled')).toBe(true);
    });

    it('records rejections without short-circuiting remaining items', async () => {
      const items = ['a', 'b', 'c'];
      const out = await mapWithConcurrency(items, 1, async (s) => {
        if (s === 'b') throw new Error('boom');
        return s.toUpperCase();
      });
      expect(out[0]).toEqual({ status: 'fulfilled', value: 'A' });
      expect(out[1].status).toBe('rejected');
      expect((out[1].reason as Error).message).toBe('boom');
      expect(out[2]).toEqual({ status: 'fulfilled', value: 'C' });
    });

    it('handles an empty input', async () => {
      const out = await mapWithConcurrency([], 4, async (n) => n);
      expect(out).toEqual([]);
    });

    it('clamps concurrency above the item count', async () => {
      const items = [1, 2];
      const out = await mapWithConcurrency(items, 100, async (n) => n);
      expect(out).toHaveLength(2);
    });
  });
});
