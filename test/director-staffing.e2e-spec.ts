import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser } from './utils/factories';
import { Role } from '../src/common/types/role.type';

const DAY = 86_400_000;
let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

// A teacher counts only when both the profile and the login are active; coverage is judged over
// sections that have students this session.
describe('Director staffing insights (e2e)', () => {
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

  async function fixture() {
    const a = await createTestSchool({ name: 'Alpha' });
    const year = await prisma.academicYear.create({
      data: {
        schoolId: a.id,
        name: 'A now',
        code: `AY${uniq()}`,
        startDate: new Date(Date.now() - 150 * DAY),
        endDate: new Date(Date.now() + 200 * DAY),
      },
    });
    const teacher = async (active: boolean, withLogin = true) => {
      const user = withLogin
        ? await createTestUser({
            role: Role.TEACHER,
            schoolId: a.id,
            isActive: active,
          })
        : null;
      return prisma.teacherProfile.create({
        data: {
          schoolId: a.id,
          userId: user?.id ?? null,
          fullName: `T ${uniq()}`,
        },
      });
    };
    const t1 = await teacher(true);
    const t2 = await teacher(false);
    await teacher(true, false);

    const classGrade = await prisma.classGrade.create({
      data: { schoolId: a.id, name: 'Grade 5' },
    });
    const section = async (
      name: string,
      students: number,
      subjectTeacherId: string | null,
    ) => {
      const s = await prisma.section.create({
        data: { schoolId: a.id, classGradeId: classGrade.id, name },
      });
      const subject = await prisma.subject.create({
        data: { schoolId: a.id, name: `Maths ${uniq()}` },
      });
      await prisma.sectionSubject.create({
        data: {
          sectionId: s.id,
          subjectId: subject.id,
          teacherId: subjectTeacherId,
        },
      });
      for (let i = 0; i < students; i++) {
        const p = await prisma.studentProfile.create({
          data: { schoolId: a.id, fullName: `S ${uniq()}` },
        });
        await prisma.enrollment.create({
          data: {
            studentId: p.id,
            sectionId: s.id,
            academicYearId: year.id,
            status: 'ACTIVE',
          },
        });
      }
      return s;
    };
    const s1 = await section('A', 2, t1.id);
    const s2 = await section('B', 1, t2.id);
    await section('Empty', 0, null);
    await prisma.sectionTeacher.create({
      data: { sectionId: s1.id, teacherId: t1.id, isPrimary: true },
    });
    await prisma.sectionTeacher.create({
      data: { sectionId: s2.id, teacherId: t2.id, isPrimary: true },
    });
    await prisma.timetable.create({
      data: {
        schoolId: a.id,
        academicYearId: year.id,
        sectionId: s1.id,
        status: 'PUBLISHED',
        workingDays: ['MONDAY'],
      },
    });
    await prisma.timetable.create({
      data: {
        schoolId: a.id,
        academicYearId: year.id,
        sectionId: s2.id,
        status: 'DRAFT',
        workingDays: ['MONDAY'],
      },
    });

    const b = await createTestSchool({ name: 'Bravo' });
    const bTeacherUser = await createTestUser({
      role: Role.TEACHER,
      schoolId: b.id,
    });
    await prisma.teacherProfile.create({
      data: { schoolId: b.id, userId: bTeacherUser.id, fullName: 'B teacher' },
    });

    const group = await prisma.schoolGroup.create({ data: { name: 'G' } });
    await prisma.school.updateMany({
      where: { id: { in: [a.id, b.id] } },
      data: { groupId: group.id },
    });
    const director = await createTestUser({
      role: Role.DIRECTOR,
      groupId: group.id,
    });
    const login = await api()
      .post('/api/auth/login')
      .send({ email: director.email, password: director.password });
    return { a, b, token: login.body.accessToken as string };
  }

  it('counts active teachers and the classes they leave uncovered', async () => {
    const { a, b, token } = await fixture();
    const res = await api()
      .get('/api/director/insights/staffing')
      .set({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);

    const alpha = res.body.branches.find((r: any) => r.schoolId === a.id).data;
    // Only t1: the deactivated login and the teacher with no login do not count.
    expect(alpha.teachers).toBe(1);
    expect(alpha.studentsPerTeacher).toEqual({
      students: 3,
      teachers: 1,
      value: 3,
    });
    // Section B's subject and class teacher is the deactivated t2; the empty section is ignored.
    expect(alpha.subjectsWithoutTeacher).toEqual({ count: 1, of: 2 });
    expect(alpha.sectionsWithoutClassTeacher).toEqual({ count: 1, of: 2 });
    // Every active section is on the timetable index, the empty one included.
    expect(alpha.timetables).toEqual({
      published: 1,
      sections: 3,
      share: { num: 1, den: 3, value: 0.3333 },
    });

    expect(
      res.body.branches.find((r: any) => r.schoolId === b.id),
    ).toMatchObject({
      status: 'no_year',
      data: { teachers: 1, studentsPerTeacher: null, timetables: null },
    });
    expect(res.body.group).toMatchObject({
      teachers: 2,
      studentsPerTeacher: { students: 3, teachers: 1, value: 3 },
      subjectsWithoutTeacher: { count: 1, of: 2 },
    });
  });

  it('counts teacher turnover over the last 90 days', async () => {
    const { a, token } = await fixture();
    const audit = (
      action: string,
      role: string,
      daysAgo: number,
      id: string,
    ) => ({
      actorUserId: 'principal',
      schoolId: a.id,
      action,
      entityType: 'User',
      entityId: id,
      metadata: { role },
      createdAt: new Date(Date.now() - daysAgo * DAY),
    });
    await prisma.auditLog.createMany({
      data: [
        audit('USER_DEACTIVATE', 'TEACHER', 10, 't-left'),
        // Deactivated then deleted: one leaver, not two.
        audit('USER_DELETE', 'TEACHER', 5, 't-left'),
        audit('USER_DEACTIVATE', 'TEACHER', 100, 't-long-ago'),
        audit('USER_DEACTIVATE', 'STUDENT', 10, 's-left'),
      ],
    });
    const joined = await prisma.user.count({
      where: { schoolId: a.id, role: 'TEACHER' },
    });
    const res = await api()
      .get('/api/director/insights/staffing')
      .set({ Authorization: `Bearer ${token}` });
    const alpha = res.body.branches.find((r: any) => r.schoolId === a.id).data;
    expect(joined).toBeGreaterThan(0);
    expect(alpha.turnover).toEqual({ joined, left: 1 });
    expect(res.body.group.turnover.left).toBe(1);
  });
});
