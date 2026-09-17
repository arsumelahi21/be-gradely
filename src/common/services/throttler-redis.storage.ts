import { Injectable, Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import { Redis } from 'ioredis';

/**
 * Rate-limit counters in Redis so the limit is per DEPLOYMENT, not per process.
 * With the default in-memory storage, N API processes each allow the full quota,
 * so the effective limit is N × THROTTLE_LIMIT — and a restart resets it.
 *
 * Built on ioredis (already a dependency) rather than a throttler-storage
 * package: the whole contract is two counters.
 *
 * Fail-OPEN on a Redis error, matching CacheService: rate limiting is protection,
 * not correctness, and a dead Redis must not take the API down with it.
 */
@Injectable()
export class ThrottlerRedisStorage implements ThrottlerStorage {
  private readonly logger = new Logger(ThrottlerRedisStorage.name);
  private readonly prefix: string;

  constructor(private readonly redis: Redis) {
    const env = process.env.CACHE_NAMESPACE ?? process.env.NODE_ENV ?? 'dev';
    this.prefix = `${env}:throttle:`;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitKey = `${this.prefix}${throttlerName}:${key}`;
    const blockKey = `${hitKey}:blocked`;

    try {
      const blockedFor = await this.redis.pttl(blockKey);
      if (blockedFor > 0) {
        const seconds = Math.ceil(blockedFor / 1000);
        return {
          totalHits: limit + 1,
          timeToExpire: seconds,
          isBlocked: true,
          timeToBlockExpire: seconds,
        };
      }

      const totalHits = await this.redis.incr(hitKey);
      // The first hit in a window owns the expiry; later hits must not extend it.
      if (totalHits === 1) await this.redis.pexpire(hitKey, ttl);
      const pttl = await this.redis.pttl(hitKey);

      const isBlocked = totalHits > limit;
      if (isBlocked && blockDuration > 0) {
        await this.redis.set(blockKey, '1', 'PX', blockDuration);
      }

      return {
        totalHits,
        timeToExpire: Math.ceil((pttl < 0 ? ttl : pttl) / 1000),
        isBlocked,
        timeToBlockExpire: isBlocked ? Math.ceil(blockDuration / 1000) : 0,
      };
    } catch (e) {
      this.logger.warn(
        `throttler storage failed (allowing request): ${(e as Error).message}`,
      );
      return {
        totalHits: 0,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    }
  }
}
