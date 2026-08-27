import { prisma } from './db';
import { createTestSchool, createTestUser } from './factories';
import { Role } from '../../src/common/types/role.type';

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

/** Builds a full school→teacher→class→section→subject→students graph; returns handles for attendance test setup. */
export async function seedClass(opts: { studentCount?: number } = {}) {
  const studentCount = opts.studentCount ?? 2;
  const school = await createTestSchool();

  const teacherUser = await createTestUser({
    role: Role.TEACHER,
    schoolId: school.id,
  });
  const teacherProfile = await prisma.teacherProfile.create({
    data: { userId: teacherUser.id, schoolId: school.id, fullName: 'Teacher' },
  });

  const academicYear = await prisma.academicYear.create({
    data: {
      schoolId: school.id,
      name: `AY-${uniq()}`,
      code: `AY${uniq()}`,
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-12-31'),
      isActive: true,
    },
  });

  const classGrade = await prisma.classGrade.create({
    data: { schoolId: school.id, name: `Grade-${uniq()}` },
  });
  const section = await prisma.section.create({
    data: {
      schoolId: school.id,
      classGradeId: classGrade.id,
      name: `Sec-${uniq()}`,
    },
  });
  const subject = await prisma.subject.create({
    data: { schoolId: school.id, name: `Subject-${uniq()}` },
  });
  const sectionSubject = await prisma.sectionSubject.create({
    data: {
      sectionId: section.id,
      subjectId: subject.id,
      teacherId: teacherProfile.id,
    },
  });

  const students: Array<{
    user: Awaited<ReturnType<typeof createTestUser>>;
    profile: Awaited<ReturnType<typeof prisma.studentProfile.create>>;
  }> = [];
  for (let i = 0; i < studentCount; i++) {
    const user = await createTestUser({
      role: Role.STUDENT,
      schoolId: school.id,
    });
    const profile = await prisma.studentProfile.create({
      data: { userId: user.id, schoolId: school.id, fullName: `Student ${i}` },
    });
    await prisma.enrollment.create({
      data: {
        studentId: profile.id,
        sectionId: section.id,
        academicYearId: academicYear.id,
        status: 'ACTIVE',
      },
    });
    students.push({ user, profile });
  }

  return {
    school,
    teacherUser,
    teacherProfile,
    academicYear,
    classGrade,
    section,
    subject,
    sectionSubject,
    students,
  };
}

/** Add a second subject in the same section taught by a DIFFERENT teacher. */
export async function addSecondSubject(
  school: {
    id: string;
  },
  sectionId: string,
) {
  const otherTeacherUser = await createTestUser({
    role: Role.TEACHER,
    schoolId: school.id,
  });
  const otherTeacherProfile = await prisma.teacherProfile.create({
    data: {
      userId: otherTeacherUser.id,
      schoolId: school.id,
      fullName: 'Other Teacher',
    },
  });
  const subject = await prisma.subject.create({
    data: { schoolId: school.id, name: `Subject-${uniq()}` },
  });
  const sectionSubject = await prisma.sectionSubject.create({
    data: {
      sectionId,
      subjectId: subject.id,
      teacherId: otherTeacherProfile.id,
    },
  });
  return { otherTeacherUser, otherTeacherProfile, subject, sectionSubject };
}
