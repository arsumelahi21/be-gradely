import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser } from './utils/factories';
import { Role } from '../src/common/types/role.type';

const DAY = 86_400_000;
const MODULES = [
  'overview',
  'fees',
  'students',
  'attendance',
  'academics',
  'staffing',
  'activity',
];
const ALL_ROUTES = [
  ...MODULES.map((m) => `/api/director/insights/${m}`),
  '/api/director/branches',
  '/api/director/principals',
  '/api/director/targets',
];

// Edges every insights route must share: empty scopes, suspended and session-less branches,
// another director's branch or group, malformed filters, and every other role.
describe('Director insights edge cases (e2e)', () => {
  let app: INestApplication;
  let tokens: Record<'a' | 'b' | 'none', string>;
  let ids: Record<
    'active' | 'suspended' | 'noSession' | 'other' | 'otherGroup',
    string
  >;
  let schoolUsers: { role: Role; token: string }[];

  const get = (token: string | null, path: string) => {
    const r = request(app.getHttpServer()).get(path);
    return token ? r.set({ Authorization: `Bearer ${token}` }) : r;
  };
  const signIn = async (user: { email: string; password: string }) => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: user.email, password: user.password });
    return res.body.accessToken as string;
  };
  const withYear = async (schoolId: string) => {
    const now = Date.now();
    await prisma.academicYear.create({
      data: {
        schoolId,
        name: 'Now',
        code: `AY-${schoolId.slice(0, 8)}`,
        startDate: new Date(now - 100 * DAY),
        endDate: new Date(now + 200 * DAY),
        isActive: true,
      },
    });
  };

  beforeEach(async () => {
    await resetDb();
    app = await createTestApp();

    const [dirA, dirB, dirNone] = await Promise.all(
      [1, 2, 3].map(() => createTestUser({ role: Role.DIRECTOR })),
    );
    const groupA = await prisma.schoolGroup.create({
      data: { name: 'A', directorId: dirA.id },
    });
    const groupB = await prisma.schoolGroup.create({
      data: { name: 'B', directorId: dirB.id },
    });
    const [active, suspended, noSession, other] = await Promise.all([
      createTestSchool({ name: 'Active' }),
      createTestSchool({ name: 'Suspended', isActive: false }),
      createTestSchool({ name: 'No session' }),
      createTestSchool({ name: 'Other' }),
    ]);
    await prisma.school.updateMany({
      where: { id: { in: [active.id, suspended.id, noSession.id] } },
      data: { groupId: groupA.id },
    });
    await prisma.school.update({
      where: { id: other.id },
      data: { groupId: groupB.id },
    });
    await Promise.all([active.id, suspended.id, other.id].map(withYear));
    ids = {
      active: active.id,
      suspended: suspended.id,
      noSession: noSession.id,
      other: other.id,
      otherGroup: groupB.id,
    };

    tokens = {
      a: await signIn(dirA),
      b: await signIn(dirB),
      none: await signIn(dirNone),
    };
    schoolUsers = [];
    for (const role of [
      Role.SCHOOL_ADMIN,
      Role.TEACHER,
      Role.PARENT,
      Role.STUDENT,
    ]) {
      const user = await createTestUser({ role, schoolId: active.id });
      schoolUsers.push({ role, token: await signIn(user) });
    }
    const sa = await createTestUser({ role: Role.SUPER_ADMIN });
    schoolUsers.push({ role: Role.SUPER_ADMIN, token: await signIn(sa) });
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('answers every route with an empty result for a director without a group', async () => {
    for (const path of ALL_ROUTES) {
      const res = await get(tokens.none, path);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
      if (res.body.branches) expect(res.body.branches).toEqual([]);
      if (res.body.groups) expect(res.body.groups).toEqual([]);
    }
  });

  it('lists a suspended branch but keeps it out of the totals until asked', async () => {
    for (const m of MODULES) {
      const plain = await get(tokens.a, `/api/director/insights/${m}`);
      const all = await get(
        tokens.a,
        `/api/director/insights/${m}?includeSuspended=true`,
      );
      expect(plain.status).toBe(200);
      const suspended = plain.body.branches.find(
        (b: { schoolId: string }) => b.schoolId === ids.suspended,
      );
      expect({ m, isActive: suspended?.isActive }).toEqual({
        m,
        isActive: false,
      });
      expect({
        m,
        extra: all.body.coverage.total - plain.body.coverage.total,
      }).toEqual({
        m,
        extra: 1,
      });
    }
  });

  it('reports a branch without a session as such, never as a failure', async () => {
    for (const m of ['overview', 'students', 'academics', 'fees']) {
      const res = await get(tokens.a, `/api/director/insights/${m}`);
      const branch = res.body.branches.find(
        (b: { schoolId: string }) => b.schoolId === ids.noSession,
      );
      expect({ m, status: branch?.status }).toEqual({ m, status: 'no_year' });
    }
  });

  it("refuses another director's branch and group on every route with a 404", async () => {
    for (const m of MODULES) {
      const branch = await get(
        tokens.a,
        `/api/director/insights/${m}?branch=${ids.other}`,
      );
      const group = await get(
        tokens.a,
        `/api/director/insights/${m}?group=${ids.otherGroup}`,
      );
      expect({ m, branch: branch.status, group: group.status }).toEqual({
        m,
        branch: 404,
        group: 404,
      });
    }
    for (const path of [
      `/api/director/insights/fees/lists?branch=${ids.other}`,
      `/api/director/insights/attendance/lists?branch=${ids.other}`,
      `/api/director/map/${ids.other}`,
    ]) {
      expect({ path, status: (await get(tokens.a, path)).status }).toEqual({
        path,
        status: 404,
      });
    }
    // The other director still sees their own branch, untouched by the refusal.
    const own = await get(
      tokens.b,
      `/api/director/insights/overview?branch=${ids.other}`,
    );
    expect(own.status).toBe(200);
    expect(
      own.body.branches.map((b: { schoolId: string }) => b.schoolId),
    ).toEqual([ids.other]);
  });

  it('answers a branch filter that names a school outside every group with a 404', async () => {
    const loose = await createTestSchool({ name: 'Ungrouped' });
    const res = await get(
      tokens.a,
      `/api/director/insights/overview?branch=${loose.id}`,
    );
    expect(res.status).toBe(404);
    const junk = await get(
      tokens.a,
      '/api/director/insights/overview?branch=not-a-branch',
    );
    expect(junk.status).toBe(404);
  });

  it('rejects malformed filters with a 400 and accepts the boundaries', async () => {
    const bad = [
      'ay=last',
      'preset=1y',
      'from=2026-01-01&to=2026-01-31',
      'preset=custom&from=2026-02-01&to=2026-01-01',
      'preset=custom&from=2024-01-01&to=2025-12-31',
      'preset=custom&from=01-01-2026&to=2026-01-31',
      'unknown=1',
    ];
    for (const q of bad) {
      const res = await get(tokens.a, `/api/director/insights/attendance?${q}`);
      expect({ q, status: res.status }).toEqual({ q, status: 400 });
    }
    const today = new Date().toISOString().slice(0, 10);
    const yearAgo = new Date(Date.now() - 365 * DAY).toISOString().slice(0, 10);
    for (const q of [
      `preset=custom&from=${today}&to=${today}`,
      `preset=custom&from=${yearAgo}&to=${today}`,
      ...['7d', '30d', '90d', 'month'].map((p) => `preset=${p}`),
      'ay=previous',
      'branch=all&group=all',
    ]) {
      const res = await get(tokens.a, `/api/director/insights/attendance?${q}`);
      expect({ q, status: res.status }).toEqual({ q, status: 200 });
    }
  });

  it('refuses every route to every other role, and to no token', async () => {
    for (const path of ALL_ROUTES) {
      for (const { role, token } of schoolUsers) {
        const res = await get(token, path);
        // The super admin may read and reset targets; every other director route is the director's.
        const allowed =
          role === Role.SUPER_ADMIN && path === '/api/director/targets';
        if (!allowed)
          expect({ path, role, status: res.status }).toEqual({
            path,
            role,
            status: 403,
          });
      }
      expect({ path, status: (await get(null, path)).status }).toEqual({
        path,
        status: 401,
      });
    }
  });
});
