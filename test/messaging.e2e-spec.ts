import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';

describe('Messaging (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await resetDb();
  });

  const startDirect = (token: string, recipientUserId: string) =>
    request(app.getHttpServer())
      .post('/api/messaging/threads')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'DIRECT', recipientUserId });

  it('lets a student message their teacher AND another student (open within school)', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const studentToken = await tokenFor(app, cls.students[0].user);

    const ok = await startDirect(studentToken, cls.teacherUser.id);
    expect(ok.status).toBe(201);
    expect(ok.body.id).toBeDefined();
    expect(ok.body.participants).toHaveLength(2);

    // Peer messaging is now open — student → student is allowed.
    const peer = await startDirect(studentToken, cls.students[1].user.id);
    expect(peer.status).toBe(201);
    expect(peer.body.participants).toHaveLength(2);
  });

  it('lets a student message any teacher in their school (no shared-class requirement)', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const studentToken = await tokenFor(app, cls.students[0].user);

    // A teacher in the SAME school who teaches a DIFFERENT section (no shared class).
    const strangerUser = await createTestUser({
      role: Role.TEACHER,
      schoolId: cls.school.id,
    });
    await prisma.teacherProfile.create({
      data: {
        userId: strangerUser.id,
        schoolId: cls.school.id,
        fullName: 'Stranger',
      },
    });

    const ok = await startDirect(studentToken, strangerUser.id);
    expect(ok.status).toBe(201);
  });

  it('blocks a school user from messaging the cross-school super-admin', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const studentToken = await tokenFor(app, cls.students[0].user);
    const superAdmin = await createTestUser({
      role: Role.SUPER_ADMIN,
      schoolId: null,
    });

    const denied = await startDirect(studentToken, superAdmin.id);
    expect(denied.status).toBe(403);
  });

  it('gates student ↔ parent to a guardian link (linked ok, unrelated blocked)', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const studentUser = cls.students[0].user;
    const studentToken = await tokenFor(app, studentUser);

    const linkedParentUser = await createTestUser({
      role: Role.PARENT,
      schoolId: cls.school.id,
    });
    const linkedParent = await prisma.parentProfile.create({
      data: { userId: linkedParentUser.id, fullName: 'Linked Parent' },
    });
    await prisma.parentStudent.create({
      data: {
        parentId: linkedParent.id,
        studentId: cls.students[0].profile.id,
      },
    });

    const strangerParentUser = await createTestUser({
      role: Role.PARENT,
      schoolId: cls.school.id,
    });
    await prisma.parentProfile.create({
      data: { userId: strangerParentUser.id, fullName: 'Stranger Parent' },
    });

    expect((await startDirect(studentToken, linkedParentUser.id)).status).toBe(
      201,
    );
    expect(
      (await startDirect(studentToken, strangerParentUser.id)).status,
    ).toBe(403);
    // Reverse direction is gated too.
    const strangerToken = await tokenFor(app, strangerParentUser);
    expect((await startDirect(strangerToken, studentUser.id)).status).toBe(403);
  });

  it('allows teacher ↔ teacher', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const otherTeacher = await createTestUser({
      role: Role.TEACHER,
      schoolId: cls.school.id,
    });
    await prisma.teacherProfile.create({
      data: {
        userId: otherTeacher.id,
        schoolId: cls.school.id,
        fullName: 'Teacher Two',
      },
    });
    const teacherToken = await tokenFor(app, cls.teacherUser);
    expect((await startDirect(teacherToken, otherTeacher.id)).status).toBe(201);
  });

  it('limits a student to one message per admin reply (formal-request discipline)', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const studentToken = await tokenFor(app, cls.students[0].user);
    const adminUser = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const adminToken = await tokenFor(app, adminUser);

    const thread = await startDirect(studentToken, adminUser.id);
    expect(thread.status).toBe(201);
    const threadId = thread.body.id;
    const send = (token: string, body: string) =>
      request(app.getHttpServer())
        .post(`/api/messaging/threads/${threadId}/messages`)
        .set('Authorization', `Bearer ${token}`)
        .send({ body });

    expect((await send(studentToken, 'Subject: X\n\nPlease help')).status).toBe(
      201,
    );
    // Second student message before any admin reply is rejected.
    expect((await send(studentToken, 'again?')).status).toBe(403);
    // Admin replies, which reopens the student's turn.
    expect((await send(adminToken, 'How can I help?')).status).toBe(201);
    expect((await send(studentToken, 'Details here')).status).toBe(201);
  });

  it('lets a linked parent message their child’s teacher', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const parentUser = await createTestUser({
      role: Role.PARENT,
      schoolId: cls.school.id,
    });
    const parentProfile = await prisma.parentProfile.create({
      data: { userId: parentUser.id, fullName: 'Parent' },
    });
    await prisma.parentStudent.create({
      data: {
        parentId: parentProfile.id,
        studentId: cls.students[0].profile.id,
      },
    });
    const parentToken = await tokenFor(app, parentUser);

    const ok = await startDirect(parentToken, cls.teacherUser.id);
    expect(ok.status).toBe(201);
  });

  it('enforces cross-school isolation when opening a thread', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const otherSchool = await createTestSchool();
    const foreignTeacher = await createTestUser({
      role: Role.TEACHER,
      schoolId: otherSchool.id,
    });
    const studentToken = await tokenFor(app, cls.students[0].user);

    const denied = await startDirect(studentToken, foreignTeacher.id);
    expect(denied.status).toBe(403);
  });

  it('only lets participants read a thread’s messages', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const studentToken = await tokenFor(app, cls.students[0].user);
    const thread = await startDirect(studentToken, cls.teacherUser.id);
    const threadId = thread.body.id;

    // A non-participant (the other student, same school) is rejected.
    const outsiderToken = await tokenFor(app, cls.students[1].user);
    const denied = await request(app.getHttpServer())
      .get(`/api/messaging/threads/${threadId}/messages`)
      .set('Authorization', `Bearer ${outsiderToken}`);
    expect(denied.status).toBe(403);
  });

  it('derives CLASS-thread participants from the section roster', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const teacherToken = await tokenFor(app, cls.teacherUser);

    const res = await request(app.getHttpServer())
      .post('/api/messaging/threads')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ type: 'CLASS', sectionId: cls.section.id });
    expect(res.status).toBe(201);
    // 2 enrolled students + their (assigned) teacher — no one extra.
    const ids = res.body.participants.map((p: any) => p.userId).sort();
    const expected = [
      cls.teacherUser.id,
      cls.students[0].user.id,
      cls.students[1].user.id,
    ].sort();
    expect(ids).toEqual(expected);
  });

  it('stores and returns a message body verbatim (XSS is data, not markup)', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const studentToken = await tokenFor(app, cls.students[0].user);
    const thread = await startDirect(studentToken, cls.teacherUser.id);
    const threadId = thread.body.id;

    const payload = '<script>alert(1)</script>';
    const sent = await request(app.getHttpServer())
      .post(`/api/messaging/threads/${threadId}/messages`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ body: payload });
    expect(sent.status).toBe(201);

    const teacherToken = await tokenFor(app, cls.teacherUser);
    const list = await request(app.getHttpServer())
      .get(`/api/messaging/threads/${threadId}/messages`)
      .set('Authorization', `Bearer ${teacherToken}`);
    expect(list.status).toBe(200);
    // Returned as-is (the frontend renders it as text — never innerHTML).
    expect(list.body.items[0].body).toBe(payload);
  });

  it('rejects a disallowed attachment MIME type server-side', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const studentToken = await tokenFor(app, cls.students[0].user);
    const thread = await startDirect(studentToken, cls.teacherUser.id);

    const res = await request(app.getHttpServer())
      .post(`/api/messaging/threads/${thread.body.id}/attachments`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({
        fileName: 'evil.exe',
        mimeType: 'application/x-msdownload',
        sizeBytes: 1024,
      });
    expect(res.status).toBe(400);
  });

  // ---- groups + broadcast + section targets (staff-only) ------------------

  it('lets a teacher create a GROUP thread with hand-picked participants', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const res = await request(app.getHttpServer())
      .post('/api/messaging/threads')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({
        type: 'GROUP',
        participantIds: [cls.students[0].user.id, cls.students[1].user.id],
        title: 'Study group',
      });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('GROUP');
    expect(res.body.title).toBe('Study group');
    const ids = res.body.participants.map((p: any) => p.userId).sort();
    expect(ids).toEqual(
      [
        cls.teacherUser.id,
        cls.students[0].user.id,
        cls.students[1].user.id,
      ].sort(),
    );
  });

  it('blocks a student from creating a GROUP thread', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const studentToken = await tokenFor(app, cls.students[0].user);
    const res = await request(app.getHttpServer())
      .post('/api/messaging/threads')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({
        type: 'GROUP',
        participantIds: [cls.students[1].user.id, cls.teacherUser.id],
      });
    expect(res.status).toBe(403);
  });

  it('broadcasts to each recipient as a separate 1:1 thread (staff only)', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const res = await request(app.getHttpServer())
      .post('/api/messaging/broadcast')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({
        recipientUserIds: [cls.students[0].user.id, cls.students[1].user.id],
        body: 'Reminder: test tomorrow',
      });
    expect(res.status).toBe(201);
    expect(res.body.sent).toBe(2);
    expect(res.body.threadIds).toHaveLength(2);

    // Each student now has one DIRECT thread carrying the message.
    const s0Token = await tokenFor(app, cls.students[0].user);
    const threads = await request(app.getHttpServer())
      .get('/api/messaging/threads')
      .set('Authorization', `Bearer ${s0Token}`);
    expect(threads.body.items).toHaveLength(1);
    expect(threads.body.items[0].type).toBe('DIRECT');
    expect(threads.body.items[0].lastMessage.body).toBe(
      'Reminder: test tomorrow',
    );
  });

  it('blocks a student from broadcasting', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const studentToken = await tokenFor(app, cls.students[0].user);
    const res = await request(app.getHttpServer())
      .post('/api/messaging/broadcast')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ recipientUserIds: [cls.students[1].user.id], body: 'hi' });
    expect(res.status).toBe(403);
  });

  it('returns a section roster grouped, excluding the actor', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const res = await request(app.getHttpServer())
      .get(`/api/messaging/sections/${cls.section.id}/roster`)
      .set('Authorization', `Bearer ${teacherToken}`);
    expect(res.status).toBe(200);
    expect(res.body.students.map((s: any) => s.id).sort()).toEqual(
      [cls.students[0].user.id, cls.students[1].user.id].sort(),
    );
    expect(Array.isArray(res.body.parents)).toBe(true);
    // The requesting teacher is excluded from the roster.
    expect(res.body.teachers.map((t: any) => t.id)).not.toContain(
      cls.teacherUser.id,
    );
  });

  it('blocks section-roster access for a teacher who does not teach it', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const stranger = await createTestUser({
      role: Role.TEACHER,
      schoolId: cls.school.id,
    });
    await prisma.teacherProfile.create({
      data: { userId: stranger.id, schoolId: cls.school.id, fullName: 'Str' },
    });
    const token = await tokenFor(app, stranger);
    const res = await request(app.getHttpServer())
      .get(`/api/messaging/sections/${cls.section.id}/roster`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('lists a teacher’s messageable sections; denies students', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const ok = await request(app.getHttpServer())
      .get('/api/messaging/sections')
      .set('Authorization', `Bearer ${teacherToken}`);
    expect(ok.status).toBe(200);
    expect(ok.body.map((s: any) => s.id)).toContain(cls.section.id);

    const studentToken = await tokenFor(app, cls.students[0].user);
    const denied = await request(app.getHttpServer())
      .get('/api/messaging/sections')
      .set('Authorization', `Bearer ${studentToken}`);
    expect(denied.status).toBe(403);
  });

  it('lets a teacher add and remove GROUP participants', async () => {
    const cls = await seedClass({ studentCount: 3 });
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const created = await request(app.getHttpServer())
      .post('/api/messaging/threads')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({
        type: 'GROUP',
        participantIds: [cls.students[0].user.id, cls.students[1].user.id],
      });
    expect(created.status).toBe(201);
    const threadId = created.body.id;

    const added = await request(app.getHttpServer())
      .post(`/api/messaging/threads/${threadId}/participants`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ userIds: [cls.students[2].user.id] });
    expect(added.status).toBe(201);
    expect(added.body.participants.map((p: any) => p.userId)).toContain(
      cls.students[2].user.id,
    );

    const removed = await request(app.getHttpServer())
      .delete(
        `/api/messaging/threads/${threadId}/participants/${cls.students[0].user.id}`,
      )
      .set('Authorization', `Bearer ${teacherToken}`);
    expect(removed.status).toBe(200);
    expect(removed.body.participants.map((p: any) => p.userId)).not.toContain(
      cls.students[0].user.id,
    );
  });

  it('blocks a student from managing GROUP participants', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const created = await request(app.getHttpServer())
      .post('/api/messaging/threads')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({
        type: 'GROUP',
        participantIds: [cls.students[0].user.id, cls.students[1].user.id],
      });
    const threadId = created.body.id;

    const studentToken = await tokenFor(app, cls.students[0].user);
    const denied = await request(app.getHttpServer())
      .post(`/api/messaging/threads/${threadId}/participants`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ userIds: [cls.students[1].user.id] });
    expect(denied.status).toBe(403);
  });

  it('lets a teacher rename a GROUP thread', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const created = await request(app.getHttpServer())
      .post('/api/messaging/threads')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({
        type: 'GROUP',
        participantIds: [cls.students[0].user.id, cls.students[1].user.id],
        title: 'Old',
      });
    const threadId = created.body.id;
    const renamed = await request(app.getHttpServer())
      .patch(`/api/messaging/threads/${threadId}`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ title: 'New name' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.title).toBe('New name');
  });

  const listThreadIds = async (token: string): Promise<string[]> => {
    const res = await request(app.getHttpServer())
      .get('/api/messaging/threads')
      .set('Authorization', `Bearer ${token}`);
    return (res.body.items as { id: string }[]).map((t) => t.id);
  };
  const sendMsg = (token: string, threadId: string, body: string) =>
    request(app.getHttpServer())
      .post(`/api/messaging/threads/${threadId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ body });
  const listBodies = async (token: string, threadId: string) => {
    const res = await request(app.getHttpServer())
      .get(`/api/messaging/threads/${threadId}/messages`)
      .set('Authorization', `Bearer ${token}`);
    return {
      status: res.status,
      bodies: (res.body.items as { body: string }[]).map((m) => m.body),
    };
  };

  it('delete chat is per-user: hides it from the deleter, not the other participant', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const studentToken = await tokenFor(app, cls.students[0].user);
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const thread = await startDirect(studentToken, cls.teacherUser.id);
    const threadId = thread.body.id as string;
    await sendMsg(studentToken, threadId, 'hi');

    const left = await request(app.getHttpServer())
      .delete(`/api/messaging/threads/${threadId}`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(left.status).toBe(200);

    // Gone from the deleter's list, still present for the other participant.
    expect(await listThreadIds(studentToken)).not.toContain(threadId);
    expect(await listThreadIds(teacherToken)).toContain(threadId);

    // The deleter is still a participant (200, not 403) but sees no old history.
    const mine = await listBodies(studentToken, threadId);
    expect(mine.status).toBe(200);
    expect(mine.bodies).toHaveLength(0);
    // The other participant still sees the full history.
    expect((await listBodies(teacherToken, threadId)).bodies).toEqual(['hi']);
  });

  it('a new message resurfaces a deleted chat: fresh for the deleter, continued for the sender', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const studentToken = await tokenFor(app, cls.students[0].user);
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const thread = await startDirect(studentToken, cls.teacherUser.id);
    const threadId = thread.body.id as string;

    await sendMsg(studentToken, threadId, 'first');
    await sendMsg(studentToken, threadId, 'second');

    // Student deletes the chat.
    await request(app.getHttpServer())
      .delete(`/api/messaging/threads/${threadId}`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(await listThreadIds(studentToken)).not.toContain(threadId);

    // Teacher (who never deleted) replies → resurfaces it for the student.
    await sendMsg(teacherToken, threadId, 'are you there?');

    // Deleter: thread is back, showing ONLY the message sent after deletion.
    expect(await listThreadIds(studentToken)).toContain(threadId);
    expect((await listBodies(studentToken, threadId)).bodies).toEqual([
      'are you there?',
    ]);

    // Sender: full history preserved (continued thread; newest-first).
    expect((await listBodies(teacherToken, threadId)).bodies).toEqual([
      'are you there?',
      'second',
      'first',
    ]);
  });

  it('lets the sender edit their message; others cannot', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const studentToken = await tokenFor(app, cls.students[0].user);
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const thread = await startDirect(studentToken, cls.teacherUser.id);
    const threadId = thread.body.id as string;
    const msg = await sendMsg(studentToken, threadId, 'helo');
    const messageId = msg.body.id as string;

    const denied = await request(app.getHttpServer())
      .patch(`/api/messaging/threads/${threadId}/messages/${messageId}`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ body: 'hacked' });
    expect(denied.status).toBe(403);

    const edited = await request(app.getHttpServer())
      .patch(`/api/messaging/threads/${threadId}/messages/${messageId}`)
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ body: 'hello' });
    expect(edited.status).toBe(200);
    expect(edited.body.editedAt).toBeTruthy();

    const teacherView = await request(app.getHttpServer())
      .get(`/api/messaging/threads/${threadId}/messages`)
      .set('Authorization', `Bearer ${teacherToken}`);
    const m = teacherView.body.items.find((x: any) => x.id === messageId);
    expect(m.body).toBe('hello');
    expect(m.editedAt).toBeTruthy();
  });

  it('unsend (scope=everyone) tombstones a message for everyone; only the sender may', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const studentToken = await tokenFor(app, cls.students[0].user);
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const thread = await startDirect(studentToken, cls.teacherUser.id);
    const threadId = thread.body.id as string;
    const msg = await sendMsg(studentToken, threadId, 'oops');
    const messageId = msg.body.id as string;

    const denied = await request(app.getHttpServer())
      .delete(
        `/api/messaging/threads/${threadId}/messages/${messageId}?scope=everyone`,
      )
      .set('Authorization', `Bearer ${teacherToken}`);
    expect(denied.status).toBe(403);

    const un = await request(app.getHttpServer())
      .delete(
        `/api/messaging/threads/${threadId}/messages/${messageId}?scope=everyone`,
      )
      .set('Authorization', `Bearer ${studentToken}`);
    expect(un.status).toBe(200);

    for (const tok of [studentToken, teacherToken]) {
      const view = await request(app.getHttpServer())
        .get(`/api/messaging/threads/${threadId}/messages`)
        .set('Authorization', `Bearer ${tok}`);
      const m = view.body.items.find((x: any) => x.id === messageId);
      expect(m).toBeDefined();
      expect(m.deleted).toBe(true);
      expect(m.body).toBe('');
    }
  });

  it('delete-for-me hides a single message for the caller only', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const studentToken = await tokenFor(app, cls.students[0].user);
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const thread = await startDirect(studentToken, cls.teacherUser.id);
    const threadId = thread.body.id as string;
    const msg = await sendMsg(studentToken, threadId, 'secret');
    const messageId = msg.body.id as string;

    const del = await request(app.getHttpServer())
      .delete(`/api/messaging/threads/${threadId}/messages/${messageId}`)
      .set('Authorization', `Bearer ${studentToken}`); // default scope=me
    expect(del.status).toBe(200);

    expect((await listBodies(studentToken, threadId)).bodies).not.toContain(
      'secret',
    );
    expect((await listBodies(teacherToken, threadId)).bodies).toContain(
      'secret',
    );
  });

  it('reply quotes a message; a target from another thread is rejected', async () => {
    const cls = await seedClass({ studentCount: 2 });
    const s0 = await tokenFor(app, cls.students[0].user);
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const threadA = await startDirect(s0, cls.teacherUser.id);
    const threadAId = threadA.body.id as string;
    const first = await sendMsg(s0, threadAId, 'question?');
    const firstId = first.body.id as string;

    const reply = await request(app.getHttpServer())
      .post(`/api/messaging/threads/${threadAId}/messages`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ body: 'answer', replyToId: firstId });
    expect(reply.status).toBe(201);

    const view = await request(app.getHttpServer())
      .get(`/api/messaging/threads/${threadAId}/messages`)
      .set('Authorization', `Bearer ${s0}`);
    const replyMsg = view.body.items.find((x: any) => x.body === 'answer');
    expect(replyMsg.replyTo?.id).toBe(firstId);
    expect(replyMsg.replyTo?.body).toBe('question?');

    // A replyToId pointing at a message in a DIFFERENT thread is rejected.
    const threadB = await startDirect(s0, cls.students[1].user.id);
    const msgInB = await sendMsg(s0, threadB.body.id as string, 'in B');
    const bad = await request(app.getHttpServer())
      .post(`/api/messaging/threads/${threadAId}/messages`)
      .set('Authorization', `Bearer ${s0}`)
      .send({ body: 'x', replyToId: msgInB.body.id });
    expect(bad.status).toBe(400);
  });

  it('reactions are one-per-person, replace on re-react, and can be removed', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const studentToken = await tokenFor(app, cls.students[0].user);
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const thread = await startDirect(studentToken, cls.teacherUser.id);
    const threadId = thread.body.id as string;
    const msg = await sendMsg(studentToken, threadId, 'nice');
    const messageId = msg.body.id as string;

    const react = (tok: string, emoji: string) =>
      request(app.getHttpServer())
        .put(
          `/api/messaging/threads/${threadId}/messages/${messageId}/reaction`,
        )
        .set('Authorization', `Bearer ${tok}`)
        .send({ emoji });
    const reactionsFor = async (tok: string) => {
      const view = await request(app.getHttpServer())
        .get(`/api/messaging/threads/${threadId}/messages`)
        .set('Authorization', `Bearer ${tok}`);
      return view.body.items.find((x: any) => x.id === messageId).reactions;
    };

    expect((await react(teacherToken, '👍')).status).toBe(200);
    expect(await reactionsFor(studentToken)).toEqual([
      { emoji: '👍', count: 1, mine: false },
    ]);

    // Re-react replaces (still one reaction, new emoji).
    await react(teacherToken, '❤️');
    expect(await reactionsFor(teacherToken)).toEqual([
      { emoji: '❤️', count: 1, mine: true },
    ]);

    const un = await request(app.getHttpServer())
      .delete(
        `/api/messaging/threads/${threadId}/messages/${messageId}/reaction`,
      )
      .set('Authorization', `Bearer ${teacherToken}`);
    expect(un.status).toBe(200);
    expect(await reactionsFor(teacherToken)).toEqual([]);
  });

  it('reports a user to admins (and blocks self-report)', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const studentToken = await tokenFor(app, cls.students[0].user);

    const ok = await request(app.getHttpServer())
      .post('/api/messaging/report')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ reportedUserId: cls.teacherUser.id, reason: 'inappropriate' });
    expect(ok.status).toBe(201);
    expect(ok.body.reported).toBe(true);

    const self = await request(app.getHttpServer())
      .post('/api/messaging/report')
      .set('Authorization', `Bearer ${studentToken}`)
      .send({ reportedUserId: cls.students[0].user.id, reason: 'x' });
    expect(self.status).toBe(400);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app.getHttpServer()).get(
      '/api/messaging/threads',
    );
    expect(res.status).toBe(401);
  });

  describe('GET /api/messaging/unread-count (top-bar badge)', () => {
    const unread = (token: string) =>
      request(app.getHttpServer())
        .get('/api/messaging/unread-count')
        .set('Authorization', `Bearer ${token}`);

    it('counts a new message for the recipient, not the sender, and clears on read', async () => {
      const cls = await seedClass({ studentCount: 2 });
      const teacherToken = await tokenFor(app, cls.teacherUser);
      const studentToken = await tokenFor(app, cls.students[0].user);

      // Baseline: nobody has unread.
      expect((await unread(studentToken)).body).toEqual({ unread: 0 });

      const thread = await startDirect(teacherToken, cls.students[0].user.id);
      expect(thread.status).toBe(201);
      const send = await request(app.getHttpServer())
        .post(`/api/messaging/threads/${thread.body.id}/messages`)
        .set('Authorization', `Bearer ${teacherToken}`)
        .send({ body: 'Hello' });
      expect(send.status).toBe(201);

      // Recipient sees 1; the sender's own message never counts.
      expect((await unread(studentToken)).body).toEqual({ unread: 1 });
      expect((await unread(teacherToken)).body).toEqual({ unread: 0 });

      // Marking the thread read clears the badge.
      await request(app.getHttpServer())
        .patch(`/api/messaging/threads/${thread.body.id}/read`)
        .set('Authorization', `Bearer ${studentToken}`);
      expect((await unread(studentToken)).body).toEqual({ unread: 0 });
    });

    it('is tenant-scoped: a message in school A never counts for school B', async () => {
      const a = await seedClass({ studentCount: 1 });
      const b = await seedClass({ studentCount: 1 });
      const aTeacher = await tokenFor(app, a.teacherUser);
      const bStudent = await tokenFor(app, b.students[0].user);

      const thread = await startDirect(aTeacher, a.students[0].user.id);
      await request(app.getHttpServer())
        .post(`/api/messaging/threads/${thread.body.id}/messages`)
        .set('Authorization', `Bearer ${aTeacher}`)
        .send({ body: 'A-only' });

      expect((await unread(bStudent)).body).toEqual({ unread: 0 });
    });

    it('rejects an unauthenticated request', async () => {
      const res = await request(app.getHttpServer()).get(
        '/api/messaging/unread-count',
      );
      expect(res.status).toBe(401);
    });
  });
});
