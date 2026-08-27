/**
 * Seed a demo class graph for the GHS demo school so attendance + quizzes can
 * be exercised in the browser. Idempotent — safe to re-run.
 *
 *   DATABASE_URL=... node scripts/seed-demo-class.mjs
 *
 * Creates (if missing): a teacher, an academic year, Grade 8 / section 8-A,
 * Math + Science subjects taught by the teacher, and enrols 3 students.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function ensureUserWithProfile({ email, fullName, role, schoolId, profile }) {
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(profile.password, 10),
        role,
        schoolId,
        isActive: true,
        ...(role === 'TEACHER' ? {} : {}),
      },
    });
  }
  return user;
}

async function main() {
  const school = await prisma.school.findFirst({ where: { code: 'GHS' } });
  if (!school) throw new Error('GHS school not found — run seed-demo first.');
  const schoolId = school.id;

  // --- Teacher ---
  const teacherUser = await ensureUserWithProfile({
    email: 'teacher@ghs.edu',
    role: 'TEACHER',
    schoolId,
    fullName: 'Mr. Ravi Menon',
    profile: { password: 'Teacher@12345678' },
  });
  let teacherProfile = await prisma.teacherProfile.findUnique({
    where: { userId: teacherUser.id },
  });
  if (!teacherProfile) {
    teacherProfile = await prisma.teacherProfile.create({
      data: { userId: teacherUser.id, schoolId, fullName: 'Mr. Ravi Menon' },
    });
  }

  // --- Academic year ---
  let academicYear = await prisma.academicYear.findFirst({
    where: { schoolId, name: '2026' },
  });
  if (!academicYear) {
    academicYear = await prisma.academicYear.create({
      data: {
        schoolId,
        name: '2026',
        code: 'GHS-AY-2026',
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-12-31'),
        isActive: true,
      },
    });
  }

  // --- Grade + section ---
  let classGrade = await prisma.classGrade.findFirst({
    where: { schoolId, name: 'Grade 8' },
  });
  if (!classGrade) {
    classGrade = await prisma.classGrade.create({
      data: { schoolId, name: 'Grade 8', code: 'G8' },
    });
  }
  let section = await prisma.section.findFirst({
    where: { classGradeId: classGrade.id, name: '8-A' },
  });
  if (!section) {
    section = await prisma.section.create({
      data: { schoolId, classGradeId: classGrade.id, name: '8-A' },
    });
  }

  // --- Subjects taught by the teacher ---
  const subjectNames = ['Mathematics', 'Science'];
  const sectionSubjects = [];
  for (const name of subjectNames) {
    let subject = await prisma.subject.findFirst({ where: { schoolId, name } });
    if (!subject) {
      subject = await prisma.subject.create({ data: { schoolId, name } });
    }
    let ss = await prisma.sectionSubject.findFirst({
      where: { sectionId: section.id, subjectId: subject.id },
    });
    if (!ss) {
      ss = await prisma.sectionSubject.create({
        data: {
          sectionId: section.id,
          subjectId: subject.id,
          teacherId: teacherProfile.id,
        },
      });
    } else if (!ss.teacherId) {
      ss = await prisma.sectionSubject.update({
        where: { id: ss.id },
        data: { teacherId: teacherProfile.id },
      });
    }
    sectionSubjects.push({ subject, ss });
  }

  // --- Students (Aisha already exists from seed-demo; add two more) ---
  const students = [
    { email: 'aisha.k@ghs.edu', fullName: 'Aisha Khan', password: 'Student@12345' },
    { email: 'rahul.s@ghs.edu', fullName: 'Rahul Sharma', password: 'Student@12345' },
    { email: 'priya.n@ghs.edu', fullName: 'Priya Nair', password: 'Student@12345' },
  ];

  for (const s of students) {
    const user = await ensureUserWithProfile({
      email: s.email,
      role: 'STUDENT',
      schoolId,
      fullName: s.fullName,
      profile: { password: s.password },
    });
    let profile = await prisma.studentProfile.findFirst({
      where: { userId: user.id },
    });
    if (!profile) {
      profile = await prisma.studentProfile.create({
        data: { userId: user.id, schoolId, fullName: s.fullName },
      });
    }
    // Enrol in section 8-A (unique on studentId+sectionId+academicYearId).
    const existing = await prisma.enrollment.findFirst({
      where: {
        studentId: profile.id,
        sectionId: section.id,
        academicYearId: academicYear.id,
      },
    });
    if (!existing) {
      await prisma.enrollment.create({
        data: {
          studentId: profile.id,
          sectionId: section.id,
          academicYearId: academicYear.id,
          status: 'ACTIVE',
        },
      });
    }
  }

  console.log('✅ Demo class graph ready:');
  console.log(`   School: ${school.name} (${school.code})`);
  console.log('   Teacher: teacher@ghs.edu / Teacher@12345678');
  console.log('   Section: Grade 8 / 8-A');
  console.log('   Subjects: Mathematics, Science (taught by the teacher)');
  console.log('   Students enrolled: Aisha Khan, Rahul Sharma, Priya Nair');
  console.log('     (all students: password Student@12345)');
  console.log(`   sectionSubject ids: ${sectionSubjects.map((x) => x.ss.id).join(', ')}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
