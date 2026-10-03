import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { Role } from '../src/common/types/role.type';

// A director messages principals, teachers and parents of their own branches, 1:1 only.
// Teachers and parents reply; only a principal may open a thread with the director.
describe('Director messaging (e2e)', () => {
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

  const api = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function fixture() {
    const a = await createTestSchool({ name: 'Alpha' });
    const f = await createTestSchool({ name: 'Foreign' });
    const user = (role: Role, schoolId: string, fullName: string) =>
      createTestUser({ role, schoolId, fullName });
    const principal = await user(Role.SCHOOL_ADMIN, a.id, 'Pat Principal');
    const teacher = await user(Role.TEACHER, a.id, 'Tina Teacher');
    const parent = await user(Role.PARENT, a.id, 'Paul Parent');
    const student = await user(Role.STUDENT, a.id, 'Sam Student');
    const foreignPrincipal = await user(
      Role.SCHOOL_ADMIN,
      f.id,
      'Far Principal',
    );

    const director = await createTestUser({
      role: Role.DIRECTOR,
      fullName: 'Dana Director',
    });
    const group = await prisma.schoolGroup.create({
      data: { name: 'G', directorId: director.id },
    });
    await prisma.school.update({
      where: { id: a.id },
      data: { groupId: group.id },
    });
    const sa = await createTestUser({ role: Role.SUPER_ADMIN });
    const login = await api()
      .post('/api/auth/login')
      .send({ email: director.email, password: director.password });
    return {
      a,
      group,
      director,
      principal,
      teacher,
      parent,
      student,
      foreignPrincipal,
      sa,
      saToken: await tokenFor(app, sa),
      dToken: login.body.accessToken as string,
      pToken: await tokenFor(app, principal),
      tToken: await tokenFor(app, teacher),
      parentToken: await tokenFor(app, parent),
    };
  }

  const openDirect = (token: string, recipientUserId: string) =>
    api()
      .post('/api/messaging/threads')
      .set(as(token))
      .send({ type: 'DIRECT', recipientUserId });
  const send = (token: string, threadId: string, body: string) =>
    api()
      .post(`/api/messaging/threads/${threadId}/messages`)
      .set(as(token))
      .send({ body });

  it('offers a director the staff and parents of their branches, never students or other schools', async () => {
    const fx = await fixture();
    const res = await api().get('/api/messaging/recipients').set(as(fx.dToken));
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.id).sort()).toEqual(
      [fx.principal.id, fx.teacher.id, fx.parent.id].sort(),
    );
    expect(res.body.every((r: any) => r.schoolId === fx.a.id)).toBe(true);

    const principalSees = await api()
      .get('/api/messaging/recipients')
      .set(as(fx.pToken));
    expect(principalSees.body.map((r: any) => r.fullName)).toContain(
      'Dana Director',
    );
    const teacherSees = await api()
      .get('/api/messaging/recipients')
      .set(as(fx.tToken));
    expect(teacherSees.body.map((r: any) => r.fullName)).not.toContain(
      'Dana Director',
    );
  });

  it('lets the director open 1:1 threads in their branches, and staff and parents reply', async () => {
    const fx = await fixture();
    const toTeacher = await openDirect(fx.dToken, fx.teacher.id);
    expect(toTeacher.status).toBe(201);
    expect(toTeacher.body).toMatchObject({ type: 'DIRECT', schoolId: fx.a.id });
    expect(
      (await send(fx.dToken, toTeacher.body.id, 'How is Grade 5?')).status,
    ).toBe(201);
    expect(
      (await send(fx.tToken, toTeacher.body.id, 'Going well')).status,
    ).toBe(201);

    expect((await openDirect(fx.dToken, fx.parent.id)).status).toBe(201);
    expect((await openDirect(fx.dToken, fx.student.id)).status).toBe(403);
    expect((await openDirect(fx.dToken, fx.foreignPrincipal.id)).status).toBe(
      404,
    );

    // Teachers and parents cannot start a thread with the director; the principal can.
    expect((await openDirect(fx.tToken, fx.director.id)).status).toBe(403);
    expect((await openDirect(fx.parentToken, fx.director.id)).status).toBe(403);
    expect((await openDirect(fx.pToken, fx.director.id)).status).toBe(201);

    const inbox = await api().get('/api/messaging/threads').set(as(fx.dToken));
    expect(inbox.body.total).toBe(3);
  });

  it('never puts a director in a group thread', async () => {
    const fx = await fixture();
    const create = await api()
      .post('/api/messaging/threads')
      .set(as(fx.pToken))
      .send({
        type: 'GROUP',
        participantIds: [fx.teacher.id, fx.director.id],
        title: 'Staff',
      });
    expect(create.status).toBe(403);

    const group = await api()
      .post('/api/messaging/threads')
      .set(as(fx.pToken))
      .send({
        type: 'GROUP',
        participantIds: [fx.teacher.id, fx.parent.id],
        title: 'Staff',
      });
    const add = await api()
      .post(`/api/messaging/threads/${group.body.id}/participants`)
      .set(as(fx.pToken))
      .send({ userIds: [fx.director.id] });
    expect(add.status).toBe(403);
  });

  it('sends individually, and sends nothing when any recipient is out of reach', async () => {
    const fx = await fixture();
    const ok = await api()
      .post('/api/messaging/broadcast')
      .set(as(fx.dToken))
      .send({
        recipientUserIds: [fx.principal.id, fx.teacher.id],
        body: 'Staff meeting Monday',
      });
    expect(ok.status).toBe(201);
    expect(ok.body.sent).toBe(2);

    const before = await prisma.message.count();
    const mixed = await api()
      .post('/api/messaging/broadcast')
      .set(as(fx.dToken))
      .send({
        recipientUserIds: [fx.parent.id, fx.foreignPrincipal.id],
        body: 'Hello',
      });
    expect(mixed.status).toBe(404);
    expect(await prisma.message.count()).toBe(before);
  });

  it('hides a detached branch’s threads at once and locks out a deactivated director', async () => {
    const fx = await fixture();
    const thread = await openDirect(fx.dToken, fx.principal.id);
    await send(fx.dToken, thread.body.id, 'Hello');

    await api()
      .delete(`/api/groups/${fx.group.id}/schools/${fx.a.id}`)
      .set(as(fx.saToken))
      .expect(200);
    expect(
      (await api().get('/api/messaging/threads').set(as(fx.dToken))).body.total,
    ).toBe(0);
    expect(
      (
        await api()
          .get(`/api/messaging/threads/${thread.body.id}/messages`)
          .set(as(fx.dToken))
      ).status,
    ).toBe(403);
    expect(
      (await api().get('/api/messaging/recipients').set(as(fx.dToken))).body,
    ).toEqual([]);
    // The principal keeps their copy.
    expect(
      (await api().get('/api/messaging/threads').set(as(fx.pToken))).body.total,
    ).toBe(1);

    await api()
      .patch(`/api/users/${fx.director.id}/active`)
      .set(as(fx.saToken))
      .send({ isActive: false })
      .expect(200);
    expect(
      (await api().get('/api/messaging/unread-count').set(as(fx.dToken)))
        .status,
    ).toBe(401);
  });

  it('keeps a director out of threads outside their scope even as a participant', async () => {
    const fx = await fixture();
    // A participant row planted in a GROUP thread must still not surface for a director.
    const group = await prisma.messageThread.create({
      data: {
        schoolId: fx.a.id,
        type: 'GROUP',
        participants: {
          create: [{ userId: fx.director.id }, { userId: fx.teacher.id }],
        },
      },
    });
    expect(
      (await api().get(`/api/messaging/threads/${group.id}`).set(as(fx.dToken)))
        .status,
    ).toBe(404);
    expect((await send(fx.dToken, group.id, 'Hi')).status).toBe(404);
    expect(
      (await api().get('/api/messaging/threads').set(as(fx.dToken))).body.total,
    ).toBe(0);
  });

  it('lets a parent report the director and the director report within their branches', async () => {
    const fx = await fixture();
    const report = (token: string, reportedUserId: string) =>
      api()
        .post('/api/messaging/report')
        .set(as(token))
        .send({ reportedUserId, reason: 'Rude' });
    expect((await report(fx.parentToken, fx.director.id)).status).toBe(201);
    expect((await report(fx.dToken, fx.teacher.id)).status).toBe(201);
    expect((await report(fx.dToken, fx.foreignPrincipal.id)).status).toBe(404);

    // Both reports go above the school: the super admin is told, the branch principal is not.
    let notified: { userId: string }[] = [];
    for (let i = 0; i < 40 && notified.length < 2; i++) {
      notified = await prisma.notification.findMany({
        where: { type: 'USER_REPORT' },
        select: { userId: true },
      });
      if (notified.length < 2) await new Promise((r) => setTimeout(r, 50));
    }
    expect(notified.map((n) => n.userId)).toEqual([fx.sa.id, fx.sa.id]);

    // And neither shows in the branch audit log the principal can read.
    let rows = 0;
    for (let i = 0; i < 40 && rows < 2; i++) {
      rows = await prisma.auditLog.count({ where: { action: 'USER_REPORT' } });
      if (rows < 2) await new Promise((r) => setTimeout(r, 50));
    }
    expect(rows).toBe(2);
    const principalLog = await api().get('/api/audit-logs').set(as(fx.pToken));
    expect(JSON.stringify(principalLog.body)).not.toContain('USER_REPORT');
  });

  it('keeps a suspended branch’s chats readable but closed to new messages', async () => {
    const fx = await fixture();
    const thread = await openDirect(fx.dToken, fx.principal.id);
    expect((await send(fx.dToken, thread.body.id, 'Hello')).status).toBe(201);
    await prisma.school.update({
      where: { id: fx.a.id },
      data: { isActive: false },
    });

    expect(
      (await api().get('/api/messaging/threads').set(as(fx.dToken))).body.total,
    ).toBe(1);
    expect((await send(fx.dToken, thread.body.id, 'Still there?')).status).toBe(
      404,
    );
  });
});
