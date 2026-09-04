import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

/** A second section in the same school+year with a subject taught by `teacherId`. */
async function addSection(
  schoolId: string,
  classGradeId: string,
  teacherId: string,
) {
  const section = await prisma.section.create({
    data: { schoolId, classGradeId, name: `Sec-${uniq()}` },
  });
  const subject = await prisma.subject.create({
    data: { schoolId, name: `Subject-${uniq()}` },
  });
  const sectionSubject = await prisma.sectionSubject.create({
    data: { sectionId: section.id, subjectId: subject.id, teacherId },
  });
  return { section, subject, sectionSubject };
}

describe('Timetable V2 (e2e)', () => {
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

  const server = () => app.getHttpServer();

  async function adminFor(schoolId: string) {
    const admin = await createTestUser({ role: Role.SCHOOL_ADMIN, schoolId });
    return tokenFor(app, admin);
  }

  /** Set up a section's timetable at a controlled clock time; returns its periods. */
  async function setup(
    sectionId: string,
    token: string,
    opts: { dayStartMin: number; dayEndMin: number; periodMinutes?: number },
  ) {
    const res = await request(server())
      .post(`/api/timetable/sections/${sectionId}/setup`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        workingDays: ['MONDAY'],
        dayStartMin: opts.dayStartMin,
        dayEndMin: opts.dayEndMin,
        periodMinutes: opts.periodMinutes ?? 45,
      });
    expect(res.status).toBe(201);
    const got = await request(server())
      .get(`/api/timetable/sections/${sectionId}`)
      .set('Authorization', `Bearer ${token}`);
    return got.body.periods as Array<{
      id: string;
      index: number;
      startMin: number;
      endMin: number;
      kind: string;
    }>;
  }

  const assign = (
    sectionId: string,
    token: string,
    body: Record<string, unknown>,
  ) =>
    request(server())
      .post(`/api/timetable/sections/${sectionId}/entries`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  // ---- setup + periods --------------------------------------------------

  it('setup generates per-section periods; second setup is refused', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await adminFor(cls.school.id);

    const periods = await setup(cls.section.id, token, {
      dayStartMin: 480,
      dayEndMin: 480 + 45 * 4,
    });
    expect(periods.length).toBe(4);
    expect(periods[0]).toMatchObject({ index: 1, startMin: 480, endMin: 525, kind: 'CLASS' });

    // running setup again on a section that already has periods -> 409
    const again = await request(server())
      .post(`/api/timetable/sections/${cls.section.id}/setup`)
      .set('Authorization', `Bearer ${token}`)
      .send({ workingDays: ['MONDAY'], dayStartMin: 480, dayEndMin: 660, periodMinutes: 45 });
    expect(again.status).toBe(409);
  });

  it('invalid period set (overlap) is rejected on bulk replace (400)', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await adminFor(cls.school.id);
    await setup(cls.section.id, token, { dayStartMin: 480, dayEndMin: 660 });

    const res = await request(server())
      .put(`/api/timetable/sections/${cls.section.id}/periods`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        periods: [
          { index: 1, startMin: 480, endMin: 530, kind: 'CLASS' },
          { index: 2, startMin: 525, endMin: 570, kind: 'CLASS' }, // overlaps P1
        ],
      });
    expect(res.status).toBe(400);
  });

  // ---- the critical conflict cases --------------------------------------

  it('CRITICAL: same teacher, overlapping clock times in two sections -> 409', async () => {
    const cls = await seedClass({ studentCount: 1 }); // section A, teacher Ahmed
    const token = await adminFor(cls.school.id);
    const other = await addSection(cls.school.id, cls.classGrade.id, cls.teacherProfile.id); // section B, same teacher

    // A: period 10:00–10:45
    const aPeriods = await setup(cls.section.id, token, { dayStartMin: 600, dayEndMin: 690 });
    // B: period 10:30–11:15 (overlaps A)
    const bPeriods = await setup(other.section.id, token, { dayStartMin: 630, dayEndMin: 720 });

    const a1 = await assign(cls.section.id, token, {
      dayOfWeek: 'MONDAY',
      periodId: aPeriods[0].id,
      sectionSubjectId: cls.sectionSubject.id,
      teacherId: cls.teacherProfile.id,
    });
    expect(a1.status).toBe(201);

    const b1 = await assign(other.section.id, token, {
      dayOfWeek: 'MONDAY',
      periodId: bPeriods[0].id,
      sectionSubjectId: other.sectionSubject.id,
      teacherId: cls.teacherProfile.id,
    });
    expect(b1.status).toBe(409);
    expect(JSON.stringify(b1.body)).toContain('TEACHER');
  });

  it('touching edges (10:00–10:45 & 10:45–11:30) do NOT conflict', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await adminFor(cls.school.id);
    const other = await addSection(cls.school.id, cls.classGrade.id, cls.teacherProfile.id);

    const aPeriods = await setup(cls.section.id, token, { dayStartMin: 600, dayEndMin: 645 }); // 10:00–10:45
    const bPeriods = await setup(other.section.id, token, { dayStartMin: 645, dayEndMin: 690 }); // 10:45–11:30-ish

    await assign(cls.section.id, token, {
      dayOfWeek: 'MONDAY', periodId: aPeriods[0].id,
      sectionSubjectId: cls.sectionSubject.id, teacherId: cls.teacherProfile.id,
    }).expect(201);
    const b1 = await assign(other.section.id, token, {
      dayOfWeek: 'MONDAY', periodId: bPeriods[0].id,
      sectionSubjectId: other.sectionSubject.id, teacherId: cls.teacherProfile.id,
    });
    expect(b1.status).toBe(201); // adjacent, not overlapping
  });

  it('section double-book (same day+period) -> 409', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await adminFor(cls.school.id);
    // a second subject in the SAME section, same teacher
    const subject2 = await prisma.subject.create({ data: { schoolId: cls.school.id, name: `S-${uniq()}` } });
    const ss2 = await prisma.sectionSubject.create({
      data: { sectionId: cls.section.id, subjectId: subject2.id, teacherId: cls.teacherProfile.id },
    });
    const periods = await setup(cls.section.id, token, { dayStartMin: 600, dayEndMin: 690 });

    await assign(cls.section.id, token, {
      dayOfWeek: 'MONDAY', periodId: periods[0].id,
      sectionSubjectId: cls.sectionSubject.id, teacherId: cls.teacherProfile.id,
    }).expect(201);
    const dup = await assign(cls.section.id, token, {
      dayOfWeek: 'MONDAY', periodId: periods[0].id,
      sectionSubjectId: ss2.id, teacherId: cls.teacherProfile.id,
    });
    expect(dup.status).toBe(409);
  });

  it('room conflict across sections at overlapping times -> 409', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await adminFor(cls.school.id);
    // second section with a DIFFERENT teacher so only the room collides
    const t2User = await createTestUser({ role: Role.TEACHER, schoolId: cls.school.id });
    const t2 = await prisma.teacherProfile.create({
      data: { userId: t2User.id, schoolId: cls.school.id, fullName: 'Other T' },
    });
    const other = await addSection(cls.school.id, cls.classGrade.id, t2.id);
    const aPeriods = await setup(cls.section.id, token, { dayStartMin: 600, dayEndMin: 690 });
    const bPeriods = await setup(other.section.id, token, { dayStartMin: 630, dayEndMin: 720 });

    await assign(cls.section.id, token, {
      dayOfWeek: 'MONDAY', periodId: aPeriods[0].id,
      sectionSubjectId: cls.sectionSubject.id, teacherId: cls.teacherProfile.id, room: 'Room 3',
    }).expect(201);
    const b = await assign(other.section.id, token, {
      dayOfWeek: 'MONDAY', periodId: bPeriods[0].id,
      sectionSubjectId: other.sectionSubject.id, teacherId: t2.id, room: 'Room 3',
    });
    expect(b.status).toBe(409);
    expect(JSON.stringify(b.body)).toContain('ROOM');
  });

  it('teacher not qualified for the subject -> 400', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await adminFor(cls.school.id);
    // a teacher with NO specialty and not the section-subject default
    const strangerUser = await createTestUser({ role: Role.TEACHER, schoolId: cls.school.id });
    const stranger = await prisma.teacherProfile.create({
      data: { userId: strangerUser.id, schoolId: cls.school.id, fullName: 'Stranger' },
    });
    const periods = await setup(cls.section.id, token, { dayStartMin: 600, dayEndMin: 690 });
    const res = await assign(cls.section.id, token, {
      dayOfWeek: 'MONDAY', periodId: periods[0].id,
      sectionSubjectId: cls.sectionSubject.id, teacherId: stranger.id,
    });
    expect(res.status).toBe(400);
  });

  // ---- teacher-options --------------------------------------------------

  it('teacher-options lists qualified teachers, flagging the busy one disabled', async () => {
    const cls = await seedClass({ studentCount: 1 }); // teacher Ahmed is default for the subject
    const token = await adminFor(cls.school.id);
    // Usman: qualified via a specialty on the same subject
    const usmanUser = await createTestUser({ role: Role.TEACHER, schoolId: cls.school.id });
    const usman = await prisma.teacherProfile.create({
      data: { userId: usmanUser.id, schoolId: cls.school.id, fullName: 'Usman' },
    });
    await prisma.teacherSubjectSpecialty.create({
      data: { teacherId: usman.id, subjectId: cls.subject.id },
    });
    // Options are limited to teachers allocated to THIS class, so give Usman a
    // subject of his own in section A.
    const usmanSubject = await prisma.subject.create({
      data: { schoolId: cls.school.id, name: `Subject-${uniq()}` },
    });
    await prisma.sectionSubject.create({
      data: {
        sectionId: cls.section.id,
        subjectId: usmanSubject.id,
        teacherId: usman.id,
      },
    });
    // Usman is busy in another section at 10:00–10:45
    const other = await addSection(cls.school.id, cls.classGrade.id, usman.id);
    const oPeriods = await setup(other.section.id, token, { dayStartMin: 600, dayEndMin: 690 });
    await assign(other.section.id, token, {
      dayOfWeek: 'MONDAY', periodId: oPeriods[0].id,
      sectionSubjectId: other.sectionSubject.id, teacherId: usman.id,
    }).expect(201);

    // section A also at 10:00–10:45
    const aPeriods = await setup(cls.section.id, token, { dayStartMin: 600, dayEndMin: 690 });
    const opts = await request(server())
      .get(`/api/timetable/sections/${cls.section.id}/teacher-options`)
      .query({ sectionSubjectId: cls.sectionSubject.id, dayOfWeek: 'MONDAY', periodId: aPeriods[0].id })
      .set('Authorization', `Bearer ${token}`);
    expect(opts.status).toBe(200);
    const byId = new Map(opts.body.options.map((o: any) => [o.fullName, o]));
    expect((byId.get('Usman') as any).available).toBe(false);
    expect((byId.get('Usman') as any).conflict).toBeTruthy();
    // Ahmed (the default teacher) is free
    const ahmed = opts.body.options.find((o: any) => o.available);
    expect(ahmed).toBeTruthy();
  });

  // ---- validation + publish gating --------------------------------------

  it('publish is blocked while a blocking conflict exists, allowed once resolved', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await adminFor(cls.school.id);
    const periods = await setup(cls.section.id, token, { dayStartMin: 600, dayEndMin: 690 });

    // assign one class so it's not empty
    await assign(cls.section.id, token, {
      dayOfWeek: 'MONDAY', periodId: periods[0].id,
      sectionSubjectId: cls.sectionSubject.id, teacherId: cls.teacherProfile.id,
    }).expect(201);

    // completion reflects 1/2 CLASS cells (2 periods × 1 day)
    const val = await request(server())
      .get(`/api/timetable/sections/${cls.section.id}/validation`)
      .set('Authorization', `Bearer ${token}`);
    expect(val.body.completion.classCells).toBe(2);
    expect(val.body.completion.assigned).toBe(1);
    expect(val.body.blocking).toHaveLength(0);

    // publish OK (warnings allowed)
    const pub = await request(server())
      .post(`/api/timetable/sections/${cls.section.id}/publish`)
      .set('Authorization', `Bearer ${token}`);
    expect(pub.status).toBe(201);
    expect(pub.body.status).toBe('PUBLISHED');

    // student now sees it
    const studentToken = await tokenFor(app, cls.students[0].user);
    const me = await request(server())
      .get('/api/timetable/me')
      .set('Authorization', `Bearer ${studentToken}`);
    expect(me.body.status).toBe('PUBLISHED');
    expect(me.body.entries).toHaveLength(1);
  });

  it('period retime that creates a teacher conflict is rejected (reconciliation)', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await adminFor(cls.school.id);
    const other = await addSection(cls.school.id, cls.classGrade.id, cls.teacherProfile.id);

    const aPeriods = await setup(cls.section.id, token, { dayStartMin: 600, dayEndMin: 690 }); // A P1 600-645
    // B: wide day, then replaced with a SINGLE period at 700-745 (no overlap yet)
    await setup(other.section.id, token, { dayStartMin: 600, dayEndMin: 780 });
    await request(server())
      .put(`/api/timetable/sections/${other.section.id}/periods`)
      .set('Authorization', `Bearer ${token}`)
      .send({ periods: [{ index: 1, startMin: 700, endMin: 745, kind: 'CLASS' }] })
      .expect(200);
    const bGot = await request(server())
      .get(`/api/timetable/sections/${other.section.id}`)
      .set('Authorization', `Bearer ${token}`);
    const bPeriod = bGot.body.periods[0];

    await assign(cls.section.id, token, {
      dayOfWeek: 'MONDAY', periodId: aPeriods[0].id,
      sectionSubjectId: cls.sectionSubject.id, teacherId: cls.teacherProfile.id,
    }).expect(201);
    await assign(other.section.id, token, {
      dayOfWeek: 'MONDAY', periodId: bPeriod.id,
      sectionSubjectId: other.sectionSubject.id, teacherId: cls.teacherProfile.id,
    }).expect(201);

    // retime B's only period to 620-665 -> now overlaps A's 600-645 (same teacher) -> reject
    const res = await request(server())
      .patch(`/api/timetable/periods/${bPeriod.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ startMin: 620, endMin: 665 });
    expect(res.status).toBe(409);

    // B's period time is unchanged (transaction rolled back)
    const bAfter = await prisma.timetablePeriod.findUnique({ where: { id: bPeriod.id } });
    expect(bAfter?.startMin).toBe(700);
  });

  // ---- single-day template -> week -------------------------------------

  it('apply-template replicates one day across all working days', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await adminFor(cls.school.id);
    // a second subject in the same section (same teacher) so we place 2 periods
    const subject2 = await prisma.subject.create({ data: { schoolId: cls.school.id, name: `S-${uniq()}` } });
    const ss2 = await prisma.sectionSubject.create({
      data: { sectionId: cls.section.id, subjectId: subject2.id, teacherId: cls.teacherProfile.id },
    });

    // Mon–Fri, two 45-min CLASS periods
    await request(server())
      .post(`/api/timetable/sections/${cls.section.id}/setup`)
      .set('Authorization', `Bearer ${token}`)
      .send({ workingDays: ['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY'], dayStartMin: 600, dayEndMin: 690, periodMinutes: 45 })
      .expect(201);
    const got = await request(server())
      .get(`/api/timetable/sections/${cls.section.id}`)
      .set('Authorization', `Bearer ${token}`);
    const periods = got.body.periods.filter((p: any) => p.kind === 'CLASS');
    expect(periods.length).toBe(2);

    const res = await request(server())
      .post(`/api/timetable/sections/${cls.section.id}/apply-template`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        templateDay: 'MONDAY',
        assignments: [
          { periodId: periods[0].id, sectionSubjectId: cls.sectionSubject.id, teacherId: cls.teacherProfile.id },
          { periodId: periods[1].id, sectionSubjectId: ss2.id, teacherId: cls.teacherProfile.id },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ count: 10, days: 5 }); // 2 periods × 5 days

    const after = await request(server())
      .get(`/api/timetable/sections/${cls.section.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(after.body.entries).toHaveLength(10);
    const mondays = after.body.entries.filter((e: any) => e.dayOfWeek === 'MONDAY');
    expect(mondays).toHaveLength(2);
  });

  it('apply-template fails atomically when a teacher clashes on some day', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await adminFor(cls.school.id);
    const other = await addSection(cls.school.id, cls.classGrade.id, cls.teacherProfile.id);

    // section B (Tue only) already has the teacher at 600–645
    await request(server())
      .post(`/api/timetable/sections/${other.section.id}/setup`)
      .set('Authorization', `Bearer ${token}`)
      .send({ workingDays: ['TUESDAY'], dayStartMin: 600, dayEndMin: 645, periodMinutes: 45 })
      .expect(201);
    const bGot = await request(server()).get(`/api/timetable/sections/${other.section.id}`).set('Authorization', `Bearer ${token}`);
    await assign(other.section.id, token, {
      dayOfWeek: 'TUESDAY', periodId: bGot.body.periods[0].id,
      sectionSubjectId: other.sectionSubject.id, teacherId: cls.teacherProfile.id,
    }).expect(201);

    // section A Mon–Fri at 600–645; applying the template replicates onto TUESDAY -> clash
    await request(server())
      .post(`/api/timetable/sections/${cls.section.id}/setup`)
      .set('Authorization', `Bearer ${token}`)
      .send({ workingDays: ['MONDAY','TUESDAY'], dayStartMin: 600, dayEndMin: 645, periodMinutes: 45 })
      .expect(201);
    const aGot = await request(server()).get(`/api/timetable/sections/${cls.section.id}`).set('Authorization', `Bearer ${token}`);
    const res = await request(server())
      .post(`/api/timetable/sections/${cls.section.id}/apply-template`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assignments: [{ periodId: aGot.body.periods[0].id, sectionSubjectId: cls.sectionSubject.id, teacherId: cls.teacherProfile.id }] });
    expect(res.status).toBe(409);
    // nothing persisted (atomic) — A still has no entries
    const after = await request(server()).get(`/api/timetable/sections/${cls.section.id}`).set('Authorization', `Bearer ${token}`);
    expect(after.body.entries).toHaveLength(0);
  });

  // ---- authorization ----------------------------------------------------

  it('cross-school write denied; teacher cannot author; other-school student cannot read', async () => {
    const cls = await seedClass({ studentCount: 1 });
    const token = await adminFor(cls.school.id);
    const periods = await setup(cls.section.id, token, { dayStartMin: 600, dayEndMin: 690 });

    // admin of another school
    const otherSchool = await createTestSchool();
    const adminBToken = await adminFor(otherSchool.id);
    const cross = await assign(cls.section.id, adminBToken, {
      dayOfWeek: 'MONDAY', periodId: periods[0].id,
      sectionSubjectId: cls.sectionSubject.id, teacherId: cls.teacherProfile.id,
    });
    expect(cross.status).toBe(403);

    // a teacher cannot author
    const teacherToken = await tokenFor(app, cls.teacherUser);
    const asTeacher = await assign(cls.section.id, teacherToken, {
      dayOfWeek: 'MONDAY', periodId: periods[0].id,
      sectionSubjectId: cls.sectionSubject.id, teacherId: cls.teacherProfile.id,
    });
    expect(asTeacher.status).toBe(403);

    // publish, then a student of a DIFFERENT school is denied on /class/:id
    await assign(cls.section.id, token, {
      dayOfWeek: 'MONDAY', periodId: periods[0].id,
      sectionSubjectId: cls.sectionSubject.id, teacherId: cls.teacherProfile.id,
    }).expect(201);
    await request(server())
      .post(`/api/timetable/sections/${cls.section.id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);

    const otherCls = await seedClass({ studentCount: 1 });
    const outsiderToken = await tokenFor(app, otherCls.students[0].user);
    const denied = await request(server())
      .get(`/api/timetable/class/${cls.section.id}`)
      .set('Authorization', `Bearer ${outsiderToken}`);
    expect(denied.status).toBe(403);
  });
});
