import { CacheService } from './cache.service';

// Exercises the in-memory backend (no REDIS_URL) — the non-trivial logic:
// TTL expiry, wrap's compute-once, and prefix-scoped invalidation.
describe('CacheService (in-memory)', () => {
  let cache: CacheService;

  beforeEach(() => {
    delete process.env.REDIS_URL; // force the in-memory store
    cache = new CacheService();
  });

  it('round-trips values and misses cleanly', async () => {
    expect(await cache.get('a')).toBeNull();
    await cache.set('a', { n: 1 }, 60);
    expect(await cache.get<{ n: number }>('a')).toEqual({ n: 1 });
  });

  it('treats past-TTL entries as a miss', async () => {
    await cache.set('exp', 'v', -1); // already expired
    expect(await cache.get('exp')).toBeNull();
  });

  it('wrap computes once, then serves from cache', async () => {
    let calls = 0;
    const compute = async () => ++calls;
    expect(await cache.wrap('w', 60, compute)).toBe(1);
    expect(await cache.wrap('w', 60, compute)).toBe(1);
    expect(calls).toBe(1);
  });

  it('delByPrefix wipes only the matching namespace', async () => {
    await cache.set('schools:list:1', 'x', 60);
    await cache.set('schools:list:2', 'y', 60);
    await cache.set('users:list:1', 'z', 60);
    await cache.delByPrefix('schools:list:');
    expect(await cache.get('schools:list:1')).toBeNull();
    expect(await cache.get('schools:list:2')).toBeNull();
    expect(await cache.get('users:list:1')).toBe('z');
  });
});
