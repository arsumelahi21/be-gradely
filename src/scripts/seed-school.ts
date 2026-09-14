/**
 * Seeds ONE new school: 6 subjects, 12 teachers, 60 students.
 *
 *   npx ts-node -r dotenv/config src/scripts/seed-school.ts
 *
 * Creates a brand-new tenant and never touches an existing one — there is no
 * wipe path here on purpose (`seed-demo.ts`'s wipe deletes every user in its
 * school, real ones included). Re-running is a no-op unless SEED_SCHOOL_CODE
 * names a code that does not exist yet.
 *
 * Ids are generated up front so every table can go in with `createMany`, and
 * the whole thing runs in ONE transaction: a failure half-way leaves no school
 * rather than a broken one.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';

const prisma = new PrismaClient();

const CODE = process.env.SEED_SCHOOL_CODE || 'NFG-001';
const SCHOOL_NAME = process.env.SEED_SCHOOL_NAME || 'Northfield Grammar School';
const PASSWORD = process.env.SEED_SCHOOL_PASSWORD || 'Seed@12345678';
const DOMAIN = 'northfield.test';

const pad = (n: number) => String(n).padStart(4, '0');

/** The ladder, with the `level` that orders classes everywhere. */
const CLASSES = [
  { name: 'PG', level: -3, fee: 250_00 },
  { name: 'Nursery', level: -2, fee: 275_00 },
  { name: 'Prep', level: -1, fee: 300_00 },
  { name: 'Grade 1', level: 1, fee: 350_00 },
  { name: 'Grade 2', level: 2, fee: 375_00 },
  { name: 'Grade 3', level: 3, fee: 400_00 },
];
const SECTION_NAMES = ['A', 'B'];
const STUDENTS_PER_SECTION = 5; // 6 classes x 2 sections x 5 = 60

const SUBJECTS = [
  'English',
  'Mathematics',
  'Science',
  'Social Studies',
  'Urdu',
  'Computer Science',
];

const TEACHER_NAMES = [
  'Ayesha Siddiqui',
  'Bilal Ahmed',
  'Clara Mendes',
  'Danish Iqbal',
  'Erum Shah',
  'Farhan Malik',
  'Gulnaz Bibi',
  'Hassan Raza',
  'Iram Javed',
  'Junaid Akhtar',
  'Kiran Fatima',
  'Laiba Noor',
];

const FIRST_NAMES = [
  'Aiza',
  'Bilal',
  'Ciara',
  'Daniyal',
  'Eshal',
  'Faizan',
  'Ghazal',
  'Haris',
  'Inaya',
  'Jibran',
  'Kainat',
  'Laiba',
  'Mahad',
  'Nimra',
  'Osama',
  'Parisa',
  'Qasim',
  'Rida',
  'Saad',
  'Tania',
  'Umar',
  'Vania',
  'Wahaj',
  'Xara',
  'Yusra',
  'Zain',
  'Areeba',
  'Basit',
  'Cyra',
  'Daud',
];
// Split by relationship: a guardian is MOTHER or FATHER for ALL their children,
// so the relationship belongs to the parent, not to each child link.
const PARENT_NAMES = {
  MOTHER: [
    'Saima',
    'Nusrat',
    'Rabia',
    'Shazia',
    'Farida',
    'Naila',
    'Uzma',
    'Samina',
    'Yasmin',
    'Zubaida',
  ],
  FATHER: [
    'Imran',
    'Tariq',
    'Nadeem',
    'Shahid',
    'Rizwan',
    'Kamran',
    'Waseem',
    'Aamir',
    'Sajid',
    'Khalid',
  ],
} as const;

const LAST_NAMES = [
  'Khan',
  'Ahmed',
  'Malik',
  'Sheikh',
  'Butt',
  'Qureshi',
  'Chaudhry',
  'Raza',
  'Farooq',
  'Hashmi',
];

async function main() {
  const existing = await prisma.school.findFirst({ where: { code: CODE } });
  if (existing) {
    console.log(
      `School ${CODE} already exists (${existing.name}) — nothing to do.\n` +
        `Set SEED_SCHOOL_CODE to a new code to seed another school.`,
    );
    return;
  }

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const yearNumber = new Date().getUTCFullYear();

  // ---- ids up front, so every insert can be a bulk createMany --------------
  const schoolId = randomUUID();
  const academicYearId = randomUUID();

  const subjects = SUBJECTS.map((name) => ({ id: randomUUID(), name }));

  const classes = CLASSES.map((c) => ({ ...c, id: randomUUID() }));
  const sections = classes.flatMap((c) =>
    SECTION_NAMES.map((name) => ({
      id: randomUUID(),
      name,
      classGradeId: c.id,
      classLevel: c.level,
      fee: c.fee,
    })),
  );

  const teachers = TEACHER_NAMES.map((fullName, i) => ({
    userId: randomUUID(),
    profileId: randomUUID(),
    fullName,
    email: `teacher${i + 1}@${DOMAIN}`,
    index: i,
  }));

  const adminUserId = randomUUID();

  // One student per slot; a handful of sibling pairs share a guardian so the
  // parent portal's child switcher has something real to switch between.
  const students = sections.flatMap((section, sIdx) =>
    Array.from({ length: STUDENTS_PER_SECTION }, (_, i) => {
      const n = sIdx * STUDENTS_PER_SECTION + i;
      const fullName = `${FIRST_NAMES[n % FIRST_NAMES.length]} ${
        LAST_NAMES[Math.floor(n / FIRST_NAMES.length) % LAST_NAMES.length]
      }`;
      return {
        userId: randomUUID(),
        profileId: randomUUID(),
        fullName,
        email: `student${n + 1}@${DOMAIN}`,
        n,
        sectionId: section.id,
        fee: section.fee,
      };
    }),
  );

  // Every 12th student shares the previous student's parent (sibling pair).
  const parentOf = new Map<number, number>(); // student index -> parent index
  const parents: {
    userId: string;
    profileId: string;
    fullName: string;
    email: string;
    phone: string;
    relationship: 'MOTHER' | 'FATHER';
  }[] = [];
  for (const s of students) {
    const isSibling = s.n > 0 && s.n % 12 === 0;
    if (isSibling) {
      parentOf.set(s.n, parents.length - 1);
      continue;
    }
    parentOf.set(s.n, parents.length);
    const relationship = parents.length % 2 === 0 ? 'MOTHER' : 'FATHER';
    const pool = PARENT_NAMES[relationship];
    parents.push({
      userId: randomUUID(),
      profileId: randomUUID(),
      // Shares the child's surname, which is what makes a sibling pair read as one family.
      fullName: `${pool[Math.floor(parents.length / 2) % pool.length]} ${s.fullName.split(' ')[1]}`,
      email: `parent${parents.length + 1}@${DOMAIN}`,
      phone: `0311${pad(parents.length + 1)}000`,
      relationship,
    });
  }

  // Each teacher can teach 2 subjects, so the timetable picker has real choice.
  const specialties = teachers.flatMap((t) => [
    {
      teacherId: t.profileId,
      subjectId: subjects[t.index % subjects.length].id,
    },
    {
      teacherId: t.profileId,
      subjectId: subjects[(t.index + 1) % subjects.length].id,
    },
  ]);

  // Subject x section, teacher round-robin, and the first teacher of each
  // section becomes its homeroom.
  const sectionSubjects: Prisma.SectionSubjectCreateManyInput[] = [];
  const sectionTeachers: Prisma.SectionTeacherCreateManyInput[] = [];
  sections.forEach((section, sIdx) => {
    subjects.forEach((subject, subIdx) => {
      // Pick a teacher who is actually qualified for this subject.
      const qualified = teachers.filter((t) =>
        specialties.some(
          (sp) => sp.teacherId === t.profileId && sp.subjectId === subject.id,
        ),
      );
      const teacher = qualified[(sIdx + subIdx) % qualified.length];
      sectionSubjects.push({
        id: randomUUID(),
        sectionId: section.id,
        subjectId: subject.id,
        teacherId: teacher.profileId,
        isPrimary: subIdx === 0,
      });
    });
    sectionTeachers.push({
      sectionId: section.id,
      teacherId: teachers[sIdx % teachers.length].profileId,
      assignmentRole: 'Class Teacher',
      isPrimary: true,
    });
  });

  await prisma.$transaction(
    async (tx) => {
      await tx.school.create({
        data: {
          id: schoolId,
          name: SCHOOL_NAME,
          code: CODE,
          isActive: true,
          currency: 'PKR',
          feeChallanPrefix: CODE.split('-')[0],
          feeDueDayOfMonth: 10,
        },
      });

      await tx.academicYear.create({
        data: {
          id: academicYearId,
          schoolId,
          name: String(yearNumber),
          code: `${CODE}-AY-${yearNumber}`,
          startDate: new Date(Date.UTC(yearNumber, 0, 1)),
          endDate: new Date(Date.UTC(yearNumber, 11, 31)),
          isActive: true,
        },
      });

      await tx.subject.createMany({
        data: subjects.map((s) => ({
          id: s.id,
          schoolId,
          name: s.name,
          isCore: true,
        })),
      });

      await tx.classGrade.createMany({
        data: classes.map((c) => ({
          id: c.id,
          schoolId,
          name: c.name,
          code: c.name.replace(/\s+/g, '').toUpperCase().slice(0, 10),
          level: c.level,
          defaultMonthlyFee: c.fee,
        })),
      });

      await tx.section.createMany({
        data: sections.map((s) => ({
          id: s.id,
          schoolId,
          classGradeId: s.classGradeId,
          name: s.name,
        })),
      });

      // ---- users (admin + teachers + parents + students) in one insert ----
      await tx.user.createMany({
        data: [
          {
            id: adminUserId,
            email: `principal@${DOMAIN}`,
            passwordHash,
            role: 'SCHOOL_ADMIN',
            schoolId,
            fullName: 'Nadia Principal',
            userCode: `${CODE}-ADM-0001`,
          },
          ...teachers.map((t) => ({
            id: t.userId,
            email: t.email,
            passwordHash,
            role: 'TEACHER' as const,
            schoolId,
            fullName: t.fullName,
            userCode: `${CODE}-TCH-${pad(t.index + 1)}`,
          })),
          ...parents.map((p, i) => ({
            id: p.userId,
            email: p.email,
            passwordHash,
            role: 'PARENT' as const,
            schoolId,
            fullName: p.fullName,
            userCode: `${CODE}-PAR-${pad(i + 1)}`,
          })),
          ...students.map((s) => ({
            id: s.userId,
            email: s.email,
            passwordHash,
            role: 'STUDENT' as const,
            schoolId,
            fullName: s.fullName,
          })),
        ],
      });

      await tx.teacherProfile.createMany({
        data: teachers.map((t) => ({
          id: t.profileId,
          userId: t.userId,
          schoolId,
          fullName: t.fullName,
          email: t.email,
          phone: `0300${pad(t.index + 1)}000`,
          isActive: true,
        })),
      });

      await tx.parentProfile.createMany({
        data: parents.map((p) => ({
          id: p.profileId,
          userId: p.userId,
          fullName: p.fullName,
          phone: p.phone,
        })),
      });

      await tx.studentProfile.createMany({
        data: students.map((s) => ({
          id: s.profileId,
          userId: s.userId,
          schoolId,
          fullName: s.fullName,
          rollNo: pad(s.n + 1),
          admissionNo: `${CODE}-${yearNumber}-${pad(s.n + 1)}`,
          guardianName: parents[parentOf.get(s.n)!].fullName,
          guardianPhone: parents[parentOf.get(s.n)!].phone,
          gender: s.n % 2 === 0 ? 'FEMALE' : 'MALE',
          dob: new Date(Date.UTC(yearNumber - 10, s.n % 12, (s.n % 27) + 1)),
          dateOfJoining: new Date(Date.UTC(yearNumber, 0, 5)),
          // Mandatory at admission: a real figure, never left unset.
          monthlyFeeAmount: s.fee,
          isActive: true,
        })),
      });

      await tx.teacherSubjectSpecialty.createMany({ data: specialties });
      await tx.sectionSubject.createMany({ data: sectionSubjects });
      await tx.sectionTeacher.createMany({ data: sectionTeachers });

      await tx.parentStudent.createMany({
        data: students.map((s) => ({
          parentId: parents[parentOf.get(s.n)!].profileId,
          studentId: s.profileId,
          relationship: parents[parentOf.get(s.n)!].relationship,
        })),
      });

      await tx.enrollment.createMany({
        data: students.map((s) => ({
          studentId: s.profileId,
          sectionId: s.sectionId,
          academicYearId,
          status: 'ACTIVE' as const,
          startDate: new Date(Date.UTC(yearNumber, 0, 5)),
        })),
      });
    },
    { timeout: 120_000, maxWait: 20_000 },
  );

  const siblingPairs = students.length - parents.length;
  console.log(`Seeded ${SCHOOL_NAME} (${CODE})`);
  console.log(`  academic year : ${yearNumber} (active)`);
  console.log(`  subjects      : ${subjects.length}`);
  console.log(
    `  classes       : ${classes.length}  (${classes.map((c) => c.name).join(', ')})`,
  );
  console.log(`  sections      : ${sections.length}  (A/B per class)`);
  console.log(
    `  teachers      : ${teachers.length}  (2 subject specialities each, 1 homeroom each)`,
  );
  console.log(
    `  students      : ${students.length}  (${STUDENTS_PER_SECTION} per section, all enrolled)`,
  );
  console.log(
    `  parents       : ${parents.length}  (${siblingPairs} sibling pair${siblingPairs === 1 ? '' : 's'})`,
  );
  console.log(
    `  subject slots : ${sectionSubjects.length}  (6 subjects x 12 sections)`,
  );
  console.log('');
  console.log(`  Login (all accounts): ${PASSWORD}`);
  console.log(`    admin    principal@${DOMAIN}`);
  console.log(`    teacher  teacher1..${teachers.length}@${DOMAIN}`);
  console.log(`    parent   parent1..${parents.length}@${DOMAIN}`);
  console.log(`    student  student1..${students.length}@${DOMAIN}`);
}

main()
  .catch((e: unknown) => {
    console.error(
      'Seed failed — nothing was written:',
      e instanceof Error ? e.message : e,
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
