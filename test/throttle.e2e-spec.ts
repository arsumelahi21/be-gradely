import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { Role } from '../src/common/types/role.type';

// Own file, and a fresh app per test, so the throttler's in-memory counters start
// at zero. Every request here comes from one IP — a school behind one address.
describe('Rate limiting (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    await resetDb();
    app = await createTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // Validation-passing but wrong, so requests reach auth (401) rather than the DTO (400).
  const WRONG = 'wrong-password-xyz';
  const login = (email: string, password: string) =>
    request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password });

  describe('sign-in', () => {
    it('throttles repeated wrong passwords on one account', async () => {
      await createTestUser({
        role: Role.STUDENT,
        email: 'brute@login.test',
        password: 'Secret@12345',
      });

      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) {
        statuses.push((await login('brute@login.test', WRONG)).status);
      }

      expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(statuses.slice(5)).toEqual([429, 429, 429]);
    });

    it('tells the user how long to wait, in plain words', async () => {
      for (let i = 0; i < 5; i++) await login('typo@login.test', WRONG);

      const res = await login('typo@login.test', WRONG);
      expect(res.status).toBe(429);
      expect(res.body.message).toMatch(
        /^Too many attempts\. Please wait \d+ seconds? and try again\.$/,
      );
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    });

    it("does not lock a classmate out after someone else's typos on the same network", async () => {
      await createTestUser({
        role: Role.STUDENT,
        email: 'classmate@login.test',
        password: 'Secret@12345',
      });
      for (let i = 0; i < 6; i++) await login('typo@login.test', WRONG);

      const res = await login('classmate@login.test', 'Secret@12345');
      expect(res.status).toBe(201);
    });

    it('counts an account the same whatever the letter case of the email', async () => {
      const spellings = [
        'Case@login.test',
        'CASE@login.test',
        'case@LOGIN.test',
      ];
      for (let i = 0; i < 5; i++) await login(spellings[i % 3], WRONG);

      expect((await login('case@login.test', WRONG)).status).toBe(429);
    });

    it('lets a class sign in together, but caps attempts across accounts per network', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 31; i++) {
        statuses.push((await login(`pupil${i}@login.test`, WRONG)).status);
      }

      expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
      expect(statuses[30]).toBe(429);
    });
  });

  describe('signed-in requests', () => {
    async function twoAdmins() {
      const school = await createTestSchool();
      const [a, b] = await Promise.all(
        [1, 2].map(() =>
          createTestUser({ role: Role.SCHOOL_ADMIN, schoolId: school.id }),
        ),
      );
      return { a, b };
    }

    const search = (token: string) =>
      request(app.getHttpServer())
        .get('/api/search')
        .query({ q: 'x' })
        .set('Authorization', `Bearer ${token}`);

    it('gives each signed-in user their own budget on a shared network', async () => {
      const { a, b } = await twoAdmins();
      const tokenA = await tokenFor(app, a);

      let last = 0;
      for (let i = 0; i < 61; i++) last = (await search(tokenA)).status;
      expect(last).toBe(429);

      expect((await search(await tokenFor(app, b))).status).toBe(200);
    });

    it("does not let a forged token spend another user's budget", async () => {
      const { b } = await twoAdmins();
      const forged = await app
        .get(JwtService)
        .signAsync({ sub: b.id, role: b.role }, { secret: 'not-the-secret' });

      for (let i = 0; i < 61; i++) await search(forged);

      expect((await search(await tokenFor(app, b))).status).toBe(200);
    });
  });
});
