import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

/**
 * Env-driven cache: Redis when `REDIS_URL` is set (prod), else in-memory (dev).
 * Fail-open on errors; callers MUST bake schoolId/userId into keys — no tenant namespacing here.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly redis: Redis | null;
  private readonly mem = new Map<string, { value: string; expires: number }>();

  constructor() {
    const url = process.env.REDIS_URL;
    if (url) {
      // Fail FAST: these options make a dead/slow Redis error quickly instead of
      // hanging — a hanging Redis once made every cached endpoint take ~50s in prod.
      this.redis = new Redis(url, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: 1000,
        commandTimeout: 1000,
        retryStrategy: (times) => Math.min(times * 500, 30000),
      });
      this.redis.on('error', (e) =>
        this.logger.warn(`Redis error (falling back to DB): ${e.message}`),
      );
      this.logger.log('Cache backend: Redis (fail-fast)');
    } else {
      this.redis = null;
      this.logger.log('Cache backend: in-memory (set REDIS_URL to use Redis)');
    }
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      if (this.redis) {
        const raw = await this.redis.get(key);
        return raw ? (JSON.parse(raw) as T) : null;
      }
      const hit = this.mem.get(key);
      if (!hit) return null;
      if (hit.expires < Date.now()) {
        this.mem.delete(key);
        return null;
      }
      return JSON.parse(hit.value) as T;
    } catch (e) {
      this.logger.warn(
        `cache get failed for "${key}": ${(e as Error).message}`,
      );
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      const raw = JSON.stringify(value);
      if (this.redis) {
        await this.redis.set(key, raw, 'EX', ttlSeconds);
        return;
      }
      this.mem.set(key, {
        value: raw,
        expires: Date.now() + ttlSeconds * 1000,
      });
    } catch (e) {
      this.logger.warn(
        `cache set failed for "${key}": ${(e as Error).message}`,
      );
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (!keys.length) return;
    try {
      if (this.redis) {
        await this.redis.del(...keys);
        return;
      }
      for (const k of keys) this.mem.delete(k);
    } catch (e) {
      this.logger.warn(`cache del failed: ${(e as Error).message}`);
    }
  }

  /**
   * Delete every key matching ANY of `prefixes` in a SINGLE keyspace pass — not
   * `for (p of prefixes) delByPrefix(p)`, which would scan once per prefix.
   */
  async delByPrefixes(...prefixes: string[]): Promise<void> {
    const ps = prefixes.filter(Boolean);
    if (!ps.length) return;
    try {
      if (this.redis) {
        let cursor = '0';
        do {
          const [next, batch] = await this.redis.scan(cursor, 'COUNT', 200);
          cursor = next;
          const matched = batch.filter((k) => ps.some((p) => k.startsWith(p)));
          if (matched.length) await this.redis.del(...matched);
        } while (cursor !== '0');
        return;
      }
      for (const k of [...this.mem.keys()]) {
        if (ps.some((p) => k.startsWith(p))) this.mem.delete(k);
      }
    } catch (e) {
      this.logger.warn(
        `cache delByPrefixes failed for [${ps.join(', ')}]: ${(e as Error).message}`,
      );
    }
  }

  /** Invalidate every key starting with `prefix` (e.g. a domain/tenant namespace). */
  async delByPrefix(prefix: string): Promise<void> {
    try {
      if (this.redis) {
        let cursor = '0';
        do {
          const [next, found] = await this.redis.scan(
            cursor,
            'MATCH',
            `${prefix}*`,
            'COUNT',
            200,
          );
          cursor = next;
          if (found.length) await this.redis.del(...found);
        } while (cursor !== '0');
        return;
      }
      for (const k of [...this.mem.keys()]) {
        if (k.startsWith(prefix)) this.mem.delete(k);
      }
    } catch (e) {
      this.logger.warn(
        `cache delByPrefix failed for "${prefix}": ${(e as Error).message}`,
      );
    }
  }

  /**
   * Get-or-compute: return the cached value, or run `compute`, cache it, return
   * it. `null`/`undefined` results are not cached (treated as a miss next time).
   */
  async wrap<T>(
    key: string,
    ttlSeconds: number,
    compute: () => Promise<T>,
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    const fresh = await compute();
    if (fresh !== null && fresh !== undefined) {
      await this.set(key, fresh, ttlSeconds);
    }
    return fresh;
  }

  onModuleDestroy() {
    this.redis?.disconnect();
  }
}
