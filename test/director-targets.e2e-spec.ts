import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser } from './utils/factories';
import { Role } from '../src/common/types/role.type';

describe('Director targets (e2e)', () => {
  let app: INestApplication;
  const api = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

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

  async function login(user: { email: string; password: string }) {
    const res = await api()
      .post('/api/auth/login')
      .send({ email: user.email, password: user.password });
    return res.body.accessToken as string;
  }

  async function fixture() {
    const a = await createTestSchool({ name: 'Alpha' });
    const b = await createTestSchool({ name: 'Bravo' });
    const foreign = await createTestSchool({ name: 'Elsewhere' });
    const group = await prisma.schoolGroup.create({ data: { name: 'G' } });
    const other = await prisma.schoolGroup.create({ data: { name: 'Other' } });
    await prisma.school.updateMany({
      where: { id: { in: [a.id, b.id] } },
      data: { groupId: group.id },
    });
    await prisma.school.update({
      where: { id: foreign.id },
      data: { groupId: other.id },
    });
    const director = await createTestUser({
      role: Role.DIRECTOR,
      groupId: group.id,
    });
    const sa = await createTestUser({ role: Role.SUPER_ADMIN });
    return {
      a,
      b,
      foreign,
      group,
      other,
      token: await login(director),
      director,
      saToken: await login(sa),
    };
  }

  const targetsOf = async (groupId: string) =>
    (await prisma.schoolGroup.findUniqueOrThrow({ where: { id: groupId } }))
      .targets;

  it('sets network targets and a branch override, and the overview uses them', async () => {
    const { a, b, group, token } = await fixture();
    expect(
      (
        await api()
          .patch('/api/director/targets')
          .set(auth(token))
          .send({ targets: { attendance: 90, resultsDays: 7 } })
      ).status,
    ).toBe(200);
    const res = await api()
      .patch('/api/director/targets')
      .set(auth(token))
      .send({ branchId: a.id, targets: { attendance: 80 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      network: { attendance: 90, resultsDays: 7 },
      branches: [
        { schoolId: a.id, targets: { attendance: 80 } },
        { schoolId: b.id, targets: {} },
      ],
    });

    const overview = await api()
      .get('/api/director/insights/overview')
      .set(auth(token));
    const row = (id: string) =>
      overview.body.branches.find((r: any) => r.schoolId === id).data;
    expect(row(a.id).targets).toMatchObject({ attendance: 80, resultsDays: 7 });
    expect(row(b.id).targets).toMatchObject({ attendance: 90, passRate: 75 });

    // An empty override goes back to inheriting.
    await api()
      .patch('/api/director/targets')
      .set(auth(token))
      .send({ branchId: a.id, targets: {} });
    expect(await targetsOf(group.id)).toEqual({
      network: { attendance: 90, resultsDays: 7 },
      branches: {},
    });

    // AuditLogService.record is fire-and-forget, so the rows can land just after the response.
    let audit: Awaited<ReturnType<typeof prisma.auditLog.findMany>> = [];
    for (let i = 0; audit.length < 3 && i < 20; i++) {
      if (i) await new Promise((r) => setTimeout(r, 50));
      audit = await prisma.auditLog.findMany({
        where: { action: 'DIRECTOR_TARGETS_UPDATE' },
        orderBy: { createdAt: 'asc' },
      });
    }
    // Kept out of the branch's own audit log: the targets are the director's.
    expect(
      audit.map((r) => [
        r.entityId,
        r.schoolId,
        (r.metadata as { branchId: string | null }).branchId,
      ]),
    ).toEqual([
      [group.id, null, null],
      [group.id, null, a.id],
      [group.id, null, a.id],
    ]);
  });

  it('refuses a branch outside the group with the same 404, and never touches another group', async () => {
    const { foreign, other, token } = await fixture();
    for (const branchId of [
      foreign.id,
      '00000000-0000-4000-8000-000000000000',
    ]) {
      const res = await api()
        .patch('/api/director/targets')
        .set(auth(token))
        .send({ branchId, targets: { attendance: 10 } });
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Branch not found');
    }
    expect(await targetsOf(other.id)).toBeNull();
  });

  it('validates the body: bounds, whole numbers, unknown keys, a groupId', async () => {
    const { token, other, group } = await fixture();
    // The route allows 10 writes a minute per user, so the cases are split over two directors.
    const second = await login(
      await createTestUser({ role: Role.DIRECTOR, groupId: group.id }),
    );
    const bodies = [
      { targets: { attendance: 101 } },
      { targets: { passRate: -1 } },
      { targets: { receiptsDays: 0 } },
      { targets: { resultsDays: 61 } },
      { targets: { collection: 50.5 } },
      { targets: { attendance: '90' } },
      { targets: { evil: 1 } },
      { targets: { attendance: 90 }, groupId: other.id },
      { branchId: 'not-a-uuid', targets: {} },
      { targets: [] },
      { targets: [{ attendance: 5 }] },
      {},
    ];
    for (const [i, body] of bodies.entries()) {
      const res = await api()
        .patch('/api/director/targets')
        .set(auth(i < 8 ? token : second))
        .send(body);
      expect([res.status, body]).toEqual([400, body]);
    }
  });

  it('is director only', async () => {
    const { a, saToken } = await fixture();
    const principal = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: a.id,
    });
    for (const token of [saToken, await login(principal)]) {
      expect(
        (
          await api()
            .patch('/api/director/targets')
            .set(auth(token))
            .send({ targets: {} })
        ).status,
      ).toBe(403);
    }
  });

  it('lets the super admin read and reset, and drops an override when its branch leaves', async () => {
    const { a, group, token, saToken } = await fixture();
    await api()
      .patch('/api/director/targets')
      .set(auth(token))
      .send({ targets: { collection: 60 } });
    await api()
      .patch('/api/director/targets')
      .set(auth(token))
      .send({ branchId: a.id, targets: { collection: 50 } });

    const read = await api().get(`/api/groups/${group.id}`).set(auth(saToken));
    expect(read.body.targets).toEqual({
      network: { collection: 60 },
      branches: { [a.id]: { collection: 50 } },
    });

    await api()
      .delete(`/api/groups/${group.id}/schools/${a.id}`)
      .set(auth(saToken))
      .expect(200);
    expect(await targetsOf(group.id)).toEqual({
      network: { collection: 60 },
      branches: {},
    });

    await api()
      .delete(`/api/groups/${group.id}/targets`)
      .set(auth(saToken))
      .expect(200);
    expect(await targetsOf(group.id)).toBeNull();
    expect(
      (await api().delete(`/api/groups/${group.id}/targets`).set(auth(token)))
        .status,
    ).toBe(403);
  });
});
