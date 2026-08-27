import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestUser } from './utils/factories';
import { Role } from '../src/common/types/role.type';

// Own file so the throttler's in-memory storage is fresh (Jest gives each file its own module registry).
// Login is limited to 5/min/IP (auth.controller @Throttle) — PLAN.md P0-13a / Phase 1 §1.5.1.
describe('Auth rate limiting (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp({ throttle: true });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('throttles rapid login attempts on the same IP', async () => {
    await resetDb();
    await createTestUser({
      role: Role.STUDENT,
      email: 'brute@login.test',
      password: 'Secret@12345',
    });

    const attempt = () =>
      request(app.getHttpServer())
        .post('/api/auth/login')
        // Validation-passing but wrong password, so requests reach auth (401)
        // rather than being rejected by the DTO (400).
        .send({ email: 'brute@login.test', password: 'wrong-password-xyz' });

    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await attempt();
      statuses.push(r.status);
    }

    // First attempt reaches auth (wrong password -> 401); once the 5/min limit
    // is exhausted the endpoint starts throttling (429) and stays blocked.
    expect(statuses[0]).toBe(401);
    expect(statuses).toContain(429);
    expect(statuses.every((s) => s === 401 || s === 429)).toBe(true);
    expect(statuses[statuses.length - 1]).toBe(429);
  });
});
