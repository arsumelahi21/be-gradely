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

  /** One director with two groups (G: Alpha, Bravo; G2: Charlie); another director's group. */
  async function fixture() {
    const [a, b, c, foreign] = await Promise.all(
      ['Alpha', 'Bravo', 'Charlie', 'Elsewhere'].map((name) =>
        createTestSchool({ name }),
      ),
    );
    const director = await createTestUser({ role: Role.DIRECTOR });
    const stranger = await createTestUser({ role: Role.DIRECTOR });
    const [group, group2, other] = await Promise.all(
      [
        ['G', director.id],
        ['G2', director.id],
        ['Other', stranger.id],
      ].map(([name, directorId]) =>
        prisma.schoolGroup.create({ data: { name, directorId } }),
      ),
    );
    await prisma.school.updateMany({
      where: { id: { in: [a.id, b.id] } },
      data: { groupId: group.id },
    });
    await prisma.school.update({
      where: { id: c.id },
      data: { groupId: group2.id },
    });
    await prisma.school.update({
      where: { id: foreign.id },
      data: { groupId: other.id },
    });
    const sa = await createTestUser({ role: Role.SUPER_ADMIN });
    return {
      a,
      b,
      c,
      foreign,
      group,
      group2,
      other,
      token: await login(director),
      director,
      saToken: await login(sa),
    };
  }

  const patch = (token: string, body: object) =>
    api().patch('/api/director/targets').set(auth(token)).send(body);
  const targetsOf = async (groupId: string) =>
    (await prisma.schoolGroup.findUniqueOrThrow({ where: { id: groupId } }))
      .targets;

  it('keeps each group its own targets, and the overview uses the branch’s group', async () => {
    const { a, b, c, group, group2, token } = await fixture();
    expect(
      (
        await patch(token, {
          groupId: group.id,
          targets: { attendance: 90, resultsDays: 7 },
        })
      ).status,
    ).toBe(200);
    const res = await patch(token, {
      groupId: group.id,
      branchId: a.id,
      targets: { attendance: 80 },
    });
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([
      {
        id: group.id,
        name: 'G',
        network: { attendance: 90, resultsDays: 7 },
        branches: [
          { schoolId: a.id, name: 'Alpha', targets: { attendance: 80 } },
          { schoolId: b.id, name: 'Bravo', targets: {} },
        ],
      },
      {
        id: group2.id,
        name: 'G2',
        network: {},
        branches: [{ schoolId: c.id, name: 'Charlie', targets: {} }],
      },
    ]);

    const overview = await api()
      .get('/api/director/insights/overview')
      .set(auth(token));
    const row = (id: string) =>
      overview.body.branches.find((r: any) => r.schoolId === id).data;
    expect(row(a.id).targets).toMatchObject({ attendance: 80, resultsDays: 7 });
    expect(row(b.id).targets).toMatchObject({ attendance: 90, passRate: 75 });
    // G2 has set nothing: defaults.
    expect(row(c.id).targets).toMatchObject({
      attendance: 75,
      resultsDays: 14,
    });

    // An empty override goes back to inheriting.
    await patch(token, { groupId: group.id, branchId: a.id, targets: {} });
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

  it('refuses another director’s group, and a branch outside the named group, with a 404', async () => {
    const { c, foreign, group, other, token } = await fixture();
    const groupRes = await patch(token, {
      groupId: other.id,
      targets: { attendance: 10 },
    });
    expect([groupRes.status, groupRes.body.message]).toEqual([
      404,
      'Group not found',
    ]);
    // Charlie is the director's own branch, but in G2, not G.
    for (const branchId of [
      foreign.id,
      c.id,
      '00000000-0000-4000-8000-000000000000',
    ]) {
      const res = await patch(token, {
        groupId: group.id,
        branchId,
        targets: { attendance: 10 },
      });
      expect([res.status, res.body.message]).toEqual([404, 'Branch not found']);
    }
    expect(await targetsOf(other.id)).toBeNull();
    expect(await targetsOf(group.id)).toBeNull();
  });

  it('validates the body: a group is required, values are bounded whole numbers', async () => {
    const { token, group } = await fixture();
    // The route allows 10 writes a minute per user, so the cases are split over two directors.
    const second = await login(await createTestUser({ role: Role.DIRECTOR }));
    const g = group.id;
    const bodies = [
      { groupId: g, targets: { attendance: 101 } },
      { groupId: g, targets: { passRate: -1 } },
      { groupId: g, targets: { receiptsDays: 0 } },
      { groupId: g, targets: { resultsDays: 61 } },
      { groupId: g, targets: { collection: 50.5 } },
      { groupId: g, targets: { attendance: '90' } },
      { groupId: g, targets: { evil: 1 } },
      { targets: { attendance: 90 } },
      { groupId: 'not-a-uuid', targets: {} },
      { groupId: g, branchId: 'not-a-uuid', targets: {} },
      { groupId: g, targets: [] },
      { groupId: g, targets: [{ attendance: 5 }] },
      { groupId: g },
    ];
    for (const [i, body] of bodies.entries()) {
      const res = await patch(i < 8 ? token : second, body);
      expect([res.status, body]).toEqual([400, body]);
    }
  });

  it('is director only', async () => {
    const { a, group, saToken } = await fixture();
    const principal = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: a.id,
    });
    for (const token of [saToken, await login(principal)]) {
      expect(
        (await patch(token, { groupId: group.id, targets: {} })).status,
      ).toBe(403);
    }
  });

  it('lets the super admin read and reset, and drops an override when its branch leaves', async () => {
    const { a, group, token, saToken } = await fixture();
    await patch(token, { groupId: group.id, targets: { collection: 60 } });
    await patch(token, {
      groupId: group.id,
      branchId: a.id,
      targets: { collection: 50 },
    });

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
