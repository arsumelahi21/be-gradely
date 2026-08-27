import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { seedClass } from './utils/class-fixture';
import { Role } from '../src/common/types/role.type';

describe('Enrollments batch (e2e)', () => {
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

  // A student in `schoolId` with no enrolment yet.
  const freshStudent = async (schoolId: string) => {
    const user = await createTestUser({ role: Role.STUDENT, schoolId });
    return prisma.studentProfile.create({
      data: { userId: user.id, schoolId, fullName: 'Fresh' },
    });
  };

  it('batch-enrols new students in one call and skips already-enrolled ones', async () => {
    const cls = await seedClass({ studentCount: 2 }); // 2 already enrolled
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const adminToken = await tokenFor(app, admin);
    const a = await freshStudent(cls.school.id);
    const b = await freshStudent(cls.school.id);

    const res = await request(app.getHttpServer())
      .post('/api/enrollments/batch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        sectionId: cls.section.id,
        academicYearId: cls.academicYear.id,
        studentIds: [
          a.id,
          b.id,
          cls.students[0].profile.id, // duplicate — already enrolled
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: 2, skipped: 1 });

    const rows = await prisma.enrollment.findMany({
      where: { sectionId: cls.section.id },
    });
    expect(rows).toHaveLength(4); // 2 seeded + 2 new
  });

  it('rejects a batch containing a cross-school student and writes nothing', async () => {
    const cls = await seedClass({ studentCount: 0 });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: cls.school.id,
    });
    const adminToken = await tokenFor(app, admin);
    const mine = await freshStudent(cls.school.id);
    const otherSchool = await createTestSchool();
    const outsider = await freshStudent(otherSchool.id);

    const res = await request(app.getHttpServer())
      .post('/api/enrollments/batch')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        sectionId: cls.section.id,
        academicYearId: cls.academicYear.id,
        studentIds: [mine.id, outsider.id],
      });

    expect(res.status).toBe(400);
    const rows = await prisma.enrollment.findMany({
      where: { sectionId: cls.section.id },
    });
    expect(rows).toHaveLength(0); // no half-enrolled roster
  });

  it('denies an admin from another school enrolling into this section', async () => {
    const cls = await seedClass({ studentCount: 0 });
    const mine = await freshStudent(cls.school.id);
    const otherSchool = await createTestSchool();
    const adminB = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: otherSchool.id,
    });
    const adminBToken = await tokenFor(app, adminB);

    const res = await request(app.getHttpServer())
      .post('/api/enrollments/batch')
      .set('Authorization', `Bearer ${adminBToken}`)
      .send({
        sectionId: cls.section.id,
        academicYearId: cls.academicYear.id,
        studentIds: [mine.id],
      });

    expect(res.status).toBe(403);
  });
});
