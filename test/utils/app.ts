import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AppModule } from '../../src/app.module';
import { S3PresignService } from '../../src/common/services/s3-presign.service';

const s3san = (s: string) => (s || '').replace(/[^a-zA-Z0-9._-]/g, '_');

/**
 * In-memory stand-in for S3 (e2e has no real bucket) — mirrors S3PresignService's
 * public surface; round-trips uploads/downloads through a Map.
 */
class InMemoryS3 {
  private store = new Map<string, Buffer>();
  async keyForSchool(schoolId: string | null | undefined, tail: string) {
    return `${schoolId ?? '_platform'}/${tail.replace(/^\/+/, '')}`;
  }
  async keyFor(
    schoolId: string | null | undefined,
    category: string,
    userId: string | null | undefined,
    fileName: string,
  ) {
    return `${schoolId ?? '_platform'}/${s3san(category)}/${s3san(userId || '_unknown')}/${s3san(fileName || 'file')}`;
  }
  async putObject(input: { key: string; body: Buffer }) {
    this.store.set(input.key, Buffer.from(input.body));
    return { bucket: 'test', key: input.key };
  }
  async getObjectBuffer(key: string) {
    const b = this.store.get(key);
    if (!b) throw new Error(`NoSuchKey: ${key}`);
    return b;
  }
  async presignPutObject(input: { key: string }) {
    return {
      url: `https://s3.test/put/${input.key}`,
      bucket: 'test',
      key: input.key,
    };
  }
  async presignGetObject(input: { key: string }) {
    return {
      url: `https://s3.test/get/${input.key}`,
      bucket: 'test',
      key: input.key,
    };
  }
}

/**
 * Boots the real Nest app for e2e tests (mirrors main.ts's `/api` prefix + ValidationPipe).
 * ThrottlerGuard is disabled by default to avoid flaky tests; pass `{ throttle: true }` to keep it on.
 */
export async function createTestApp({
  throttle = false,
}: { throttle?: boolean } = {}): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] });

  if (!throttle) {
    builder.overrideGuard(ThrottlerGuard).useValue({ canActivate: () => true });
  }

  // No real S3 in e2e — round-trip uploads/downloads through an in-memory fake.
  builder.overrideProvider(S3PresignService).useValue(new InMemoryS3());

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();
  return app;
}
