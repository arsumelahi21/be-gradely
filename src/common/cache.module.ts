import { Global, Module } from '@nestjs/common';
import { CacheService } from './services/cache.service';

/** Global cache module — provides {@link CacheService} app-wide (in-memory locally, Redis when REDIS_URL is set). */
@Global()
@Module({
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
