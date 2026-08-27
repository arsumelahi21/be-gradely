/**
 * Demo seed (DEMO-001): one full-feature demo school for the Phase 4.1 dashboards. Idempotent
 * (skips if it exists; SEED_DEMO_FORCE=1 wipes+re-seeds). Run: npx ts-node src/scripts/seed-demo.ts
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();
const CODE = 'DEMO-001';
const PASSWORD = 'Demo@12345678';

const pad = (n: number) => String(n).padStart(4, '0');

/** Weekdays from `days` ago up to and including today (UTC date-only). */
function recentWeekdays(days: number): Date[] {
  const out: Date[] = [];
  const now = new Date();
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  for (let i = days; i >= 0; i--) {
    const d = new Date(today - i * 86400000);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d); // skip Sun/Sat
  }
  return out;
}

/**
 * Accounts this script creates. Everything else sitting in the demo school is
 * REAL data that happens to live there, and must survive a re-seed — a previous
 * version deleted every user in the school and destroyed a genuine admin.
 */
const SEED_EMAIL_SUFFIX = '@demo-academy.test';
const seedUsers = (schoolId: string) => ({
  schoolId,
  email: { endsWith: SEED_EMAIL_SUFFIX },
});

async function wipe(schoolId: string) {
  // Delete in FK-safe order (children first). Messages/attendance/results, then
  // structure, then profiles + users. The School row itself is NOT deleted —
  // see main(): keeping it makes the school id stable across re-seeds, so
  // surviving users keep their link and AuditLog rows don't strand.
  const students = await prisma.studentProfile.findMany({
    where: { schoolId },
    select: { id: true },
  });
  const studentIds = students.map((s) => s.id);
  // Fees first: Challan.studentId and Payment.challanId are Restrict, so
  // students/challans can't be deleted while these rows exist.
  // PaymentSubmission.challanId is Restrict too — it must go before the challan.
  await prisma.paymentSubmission.deleteMany({ where: { schoolId } });
  await prisma.payment.deleteMany({ where: { schoolId } });
  await prisma.challanItem.deleteMany({ where: { challan: { schoolId } } });
  await prisma.challan.deleteMany({ where: { schoolId } });
  // Installments cascade from the plan; the plan must go before its students.
  await prisma.feeInstallmentPlan.deleteMany({ where: { schoolId } });
  await prisma.feeHead.deleteMany({ where: { schoolId } });
  await prisma.bankAccount.deleteMany({ where: { schoolId } });
  await prisma.discount.deleteMany({ where: { schoolId } });
  await prisma.attendance.deleteMany({ where: { schoolId } });
  await prisma.examResult.deleteMany({ where: { student: { schoolId } } });
  await prisma.exam.deleteMany({ where: { schoolId } });
  await prisma.assignmentSubmission.deleteMany({
    where: { assignment: { schoolId } },
  });
  await prisma.assignmentAttachment.deleteMany({
    where: { assignment: { schoolId } },
  });
  await prisma.assignment.deleteMany({ where: { schoolId } });
  await prisma.quizAttempt.deleteMany({ where: { quiz: { schoolId } } });
  await prisma.question.deleteMany({ where: { quiz: { schoolId } } });
  await prisma.quiz.deleteMany({ where: { schoolId } });
  await prisma.message.deleteMany({ where: { thread: { schoolId } } });
  await prisma.threadParticipant.deleteMany({
    where: { thread: { schoolId } },
  });
  await prisma.messageThread.deleteMany({ where: { schoolId } });
  await prisma.announcement.deleteMany({ where: { schoolId } });
  await prisma.parentStudent.deleteMany({
    where: { studentId: { in: studentIds } },
  });
  await prisma.enrollment.deleteMany({ where: { section: { schoolId } } });
  await prisma.sectionSubject.deleteMany({ where: { section: { schoolId } } });
  await prisma.sectionTeacher.deleteMany({ where: { section: { schoolId } } });
  await prisma.section.deleteMany({ where: { schoolId } });
  await prisma.classGrade.deleteMany({ where: { schoolId } });
  await prisma.subject.deleteMany({ where: { schoolId } });
  await prisma.academicYear.deleteMany({ where: { schoolId } });
  // Profiles and users are scoped to SEED-CREATED accounts only. Scoping by
  // schoolId alone cannot tell a seeded account from a real one.
  await prisma.studentProfile.deleteMany({
    where: { schoolId, user: seedUsers(schoolId) },
  });
  await prisma.teacherProfile.deleteMany({
    where: { schoolId, user: seedUsers(schoolId) },
  });
  await prisma.parentProfile.deleteMany({
    where: { user: seedUsers(schoolId) },
  });
  await prisma.userSettings.deleteMany({
    where: { user: seedUsers(schoolId) },
  });
  await prisma.user.deleteMany({ where: seedUsers(schoolId) });
}

async function main() {
  const existing = await prisma.school.findUnique({ where: { code: CODE } });
  if (existing) {
    if (!process.env.SEED_DEMO_FORCE) {
      console.log(
        `Demo school ${CODE} already exists — skipping. Set SEED_DEMO_FORCE=1 to wipe and re-seed.`,
      );
      return;
    }
    console.log(`SEED_DEMO_FORCE set — wiping existing ${CODE}…`);
    await wipe(existing.id);
  }

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const schoolData = {
    name: 'Demo Academy',
    address: 'Springfield, USA',
    city: 'Springfield',
    country: 'United States',
    email: 'office@demo-academy.test',
    // Fee configuration lives on School (there is no FeeSettings model).
    currency: 'PKR',
    feeChallanPrefix: 'DEMO',
    feeDueDayOfMonth: 10,
  };
  // Upsert, never delete-and-recreate: the school id must stay STABLE across
  // re-seeds. A new id each time orphans real users (School->User is SetNull)
  // and strands AuditLog rows, which have a schoolId but no FK.
  const school = await prisma.school.upsert({
    where: { code: CODE },
    update: schoolData,
    create: { ...schoolData, code: CODE },
  });
  const sid = school.id;

  // --- Fee catalogue (amounts in MINOR units) ---
  await prisma.feeHead.createMany({
    data: [
      {
        schoolId: sid,
        name: 'Transport Fee',
        defaultAmount: 10000,
        sortOrder: 1,
      },
      { schoolId: sid, name: 'Library Fee', defaultAmount: 2500, sortOrder: 2 },
      // Inactive on purpose, so "deactivated heads are excluded" is visible.
      {
        schoolId: sid,
        name: 'Sports Fee',
        defaultAmount: 1500,
        sortOrder: 3,
        isActive: false,
      },
    ],
  });
  await prisma.bankAccount.create({
    data: {
      schoolId: sid,
      bankName: 'Demo Bank',
      accountTitle: 'Demo Academy',
      accountNumber: 'DEMO-0001-2345',
      iban: 'PK00DEMO0000000000012345',
      branch: 'Springfield Main',
      isDefault: true,
    },
  });
  const siblingDiscount = await prisma.discount.create({
    data: {
      schoolId: sid,
      name: 'Sibling Discount',
      type: 'PERCENT',
      value: 10,
    },
  });

  // --- School admin ---
  const admin = await prisma.user.create({
    data: {
      email: 'principal@demo-academy.test',
      passwordHash,
      role: 'SCHOOL_ADMIN',
      schoolId: sid,
      fullName: 'Dana Principal',
      userCode: 'ADM-0001',
    },
  });

  // --- Academic year, subjects, grades, sections ---
  const year = await prisma.academicYear.create({
    data: {
      schoolId: sid,
      name: '2026',
      code: `DEMO-AY-2026`,
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-12-31'),
      isActive: true,
    },
  });

  const subjectNames = ['Mathematics', 'English', 'Science'];
  const subjects: any[] = [];
  for (const name of subjectNames) {
    subjects.push(
      await prisma.subject.create({ data: { schoolId: sid, name } }),
    );
  }

  const gradeDefs = ['Grade 6', 'Grade 7'];
  const sections: any[] = [];
  for (const gname of gradeDefs) {
    const grade = await prisma.classGrade.create({
      data: { schoolId: sid, name: gname },
    });
    const section = await prisma.section.create({
      data: { schoolId: sid, classGradeId: grade.id, name: 'A' },
    });
    sections.push({ grade, section });
  }

  // --- Teachers (+profiles) ---
  const teacherNames = ['Alex Rivera', 'Sam Chen', 'Priya Patel'];
  const teachers: any[] = [];
  for (let i = 0; i < teacherNames.length; i++) {
    const user = await prisma.user.create({
      data: {
        email: `teacher${i + 1}@demo-academy.test`,
        passwordHash,
        role: 'TEACHER',
        schoolId: sid,
        fullName: teacherNames[i],
        userCode: `TCH-${pad(i + 1)}`,
      },
    });
    const profile = await prisma.teacherProfile.create({
      data: {
        userId: user.id,
        schoolId: sid,
        fullName: teacherNames[i],
        email: user.email,
      },
    });
    teachers.push({ user, profile });
  }

  // --- SectionSubjects (subject × section, round-robin teacher) + homeroom ---
  const sectionSubjects: {
    id: string;
    sectionId: string;
    teacher: (typeof teachers)[number];
  }[] = [];
  let ssCounter = 0;
  for (const { section } of sections) {
    for (let s = 0; s < subjects.length; s++) {
      const teacher = teachers[ssCounter % teachers.length];
      const ss = await prisma.sectionSubject.create({
        data: {
          sectionId: section.id,
          subjectId: subjects[s].id,
          teacherId: teacher.profile.id,
          isPrimary: s === 0,
        },
      });
      sectionSubjects.push({
        id: ss.id,
        sectionId: section.id,
        teacher,
      });
      ssCounter++;
    }
    // Homeroom teacher = teacher of the first subject.
    await prisma.sectionTeacher.create({
      data: {
        sectionId: section.id,
        teacherId: teachers[0].profile.id,
        isPrimary: true,
      },
    });
  }

  // --- Parents + students (4 per section). Parent 0 has 2 children (siblings). ---
  const firstNames = [
    'Emma',
    'Liam',
    'Olivia',
    'Noah',
    'Ava',
    'Mason',
    'Sophia',
    'Lucas',
  ];
  const students: { id: string; userId: string; sectionId: string }[] = [];
  let parentIdx = 0;
  const parents: { id: string; userId: string }[] = [];

  async function makeParent(name: string) {
    const idx = parentIdx++;
    const user = await prisma.user.create({
      data: {
        email: `parent${idx + 1}@demo-academy.test`,
        passwordHash,
        role: 'PARENT',
        schoolId: sid,
        fullName: name,
        userCode: `PAR-${pad(idx + 1)}`,
      },
    });
    const profile = await prisma.parentProfile.create({
      data: { userId: user.id, fullName: name, phone: '555-0100' },
    });
    parents.push({ id: profile.id, userId: user.id });
    return profile;
  }

  for (let i = 0; i < firstNames.length; i++) {
    const sectionIdx = i < 4 ? 0 : 1;
    const section = sections[sectionIdx].section;
    const name = `${firstNames[i]} Demo`;

    const user = await prisma.user.create({
      data: {
        email: `student${i + 1}@demo-academy.test`,
        passwordHash,
        role: 'STUDENT',
        schoolId: sid,
        fullName: name,
      },
    });
    const profile = await prisma.studentProfile.create({
      data: {
        userId: user.id,
        schoolId: sid,
        fullName: name,
        rollNo: pad(i + 1),
        admissionNo: `DEMO-2026-${pad(i + 1)}`,
        gender: i % 2 === 0 ? 'FEMALE' : 'MALE',
        dob: new Date('2014-05-15'),
        dateOfJoining: new Date('2026-01-05'),
        // Explicit fees so the module is demonstrable. Student 3 is on 0 —
        // a valid amount that must settle immediately, not a missing value.
        monthlyFeeAmount: i === 3 ? 0 : 500000 + i * 25000,
        // Siblings (students 0 & 1 share a guardian) carry the discount.
        discountId: i < 2 ? siblingDiscount.id : null,
      },
    });

    // Guardian: siblings (students 0 & 1) share parent 0; others 1:1.
    let parent = parents[0];
    if (i === 0) parent = { ...(await makeParent('Jordan Demo')) };
    else if (i >= 2)
      parent = { ...(await makeParent(`${firstNames[i]}'s Parent`)) };
    await prisma.parentStudent.create({
      data: {
        parentId: parent.id,
        studentId: profile.id,
        relationship: i % 2 === 0 ? 'MOTHER' : 'FATHER',
      },
    });

    await prisma.enrollment.create({
      data: {
        studentId: profile.id,
        sectionId: section.id,
        academicYearId: year.id,
        status: 'ACTIVE',
      },
    });
    students.push({ id: profile.id, userId: user.id, sectionId: section.id });
  }

  // --- Installment plan for student 0 ---
  // Deliberately spans the reminder window: one installment already past due
  // (reads OVERDUE), one due inside the default 3-day window (so a sweep has
  // something to find), and one still ahead — every state visible without
  // waiting for the calendar.
  {
    const today = new Date();
    const day = (offset: number) =>
      new Date(
        Date.UTC(
          today.getUTCFullYear(),
          today.getUTCMonth(),
          today.getUTCDate() + offset,
        ),
      );
    const schedule = [
      { amount: 200000, dueDate: day(-30) },
      { amount: 200000, dueDate: day(2) },
      { amount: 200000, dueDate: day(45) },
    ];
    const plan = await prisma.feeInstallmentPlan.create({
      data: {
        schoolId: sid,
        studentId: students[0].id,
        academicYearId: year.id,
        totalAmount: schedule.reduce((s, r) => s + r.amount, 0),
        startDate: schedule[0].dueDate,
        isActive: true,
      },
    });
    await prisma.feeInstallment.createMany({
      data: schedule.map((r, i) => ({ planId: plan.id, seq: i + 1, ...r })),
    });
  }

  // --- Attendance: ~10 weekdays incl. today, present-heavy mix ---
  const days = recentWeekdays(13);
  let aCounter = 0;
  const attendanceRows: any[] = [];
  for (const ss of sectionSubjects) {
    const roster = students.filter((s) => s.sectionId === ss.sectionId);
    for (const st of roster) {
      for (const date of days) {
        aCounter++;
        const status =
          aCounter % 17 === 0
            ? 'ABSENT'
            : aCounter % 13 === 0
              ? 'LATE'
              : aCounter % 29 === 0
                ? 'EXCUSED'
                : 'PRESENT';
        attendanceRows.push({
          schoolId: sid,
          studentId: st.id,
          sectionSubjectId: ss.id,
          date,
          period: 1,
          status,
          markedByUserId: ss.teacher.user.id,
        });
      }
    }
  }
  await prisma.attendance.createMany({ data: attendanceRows });

  // --- Assignments (2 per sectionSubject, PUBLISHED) + submissions mix ---
  let subCounter = 0;
  for (const ss of sectionSubjects) {
    const roster = students.filter((s) => s.sectionId === ss.sectionId);
    for (let a = 0; a < 2; a++) {
      const assignment = await prisma.assignment.create({
        data: {
          schoolId: sid,
          academicYearId: year.id,
          sectionSubjectId: ss.id,
          createdByTeacherId: ss.teacher.profile.id,
          title: `Assignment ${a + 1}`,
          description: 'Demo assignment',
          status: 'PUBLISHED',
          maxScore: 100,
          dueAt: new Date(Date.now() + 5 * 86400000),
        },
      });
      for (const st of roster) {
        subCounter++;
        // ~1 in 4 missing; of the rest, ~half graded, half ungraded.
        if (subCounter % 4 === 0) continue; // missing
        const graded = subCounter % 2 === 0;
        await prisma.assignmentSubmission.create({
          data: {
            assignmentId: assignment.id,
            studentId: st.id,
            status: graded ? 'MARKED' : 'SUBMITTED',
            s3Key: `demo/${assignment.id}/${st.id}`,
            fileName: 'submission.pdf',
            submittedAt: new Date(),
            markedAt: graded ? new Date() : null,
            score: graded ? 60 + (subCounter % 41) : null,
          },
        });
      }
    }
  }

  // --- Exams (1 per sectionSubject, PUBLISHED) + results ---
  let resCounter = 0;
  for (const ss of sectionSubjects) {
    const roster = students.filter((s) => s.sectionId === ss.sectionId);
    const exam = await prisma.exam.create({
      data: {
        schoolId: sid,
        academicYearId: year.id,
        sectionSubjectId: ss.id,
        createdByTeacherId: ss.teacher.profile.id,
        title: 'Midterm Exam',
        status: 'PUBLISHED',
        maxScore: 100,
        heldAt: new Date(Date.now() - 3 * 86400000),
      },
    });
    for (const st of roster) {
      resCounter++;
      await prisma.examResult.create({
        data: {
          examId: exam.id,
          studentId: st.id,
          score: 55 + (resCounter % 41),
          markedAt: new Date(),
        },
      });
    }
  }

  // --- Quiz per section (PUBLISHED) with 3 questions + attempts ---
  for (const { section } of sections) {
    const roster = students.filter((s) => s.sectionId === section.id);
    const teacher = teachers[0];
    const quiz = await prisma.quiz.create({
      data: {
        schoolId: sid,
        sectionId: section.id,
        subjectId: subjects[0].id,
        title: 'Weekly Quiz',
        description: 'Demo quiz',
        durationMins: 15,
        isPublished: true,
        createdByUserId: teacher.user.id,
      },
    });
    const q1 = await prisma.question.create({
      data: {
        quizId: quiz.id,
        type: 'MULTIPLE_CHOICE',
        text: '2 + 2 = ?',
        options: [
          { id: 'a', text: '3' },
          { id: 'b', text: '4' },
          { id: 'c', text: '5' },
        ],
        correctAnswer: 'b',
        points: 1,
        order: 1,
      },
    });
    const q2 = await prisma.question.create({
      data: {
        quizId: quiz.id,
        type: 'TRUE_FALSE',
        text: 'The sky is blue.',
        correctAnswer: true,
        points: 1,
        order: 2,
      },
    });
    // Half the roster attempts (submitted + graded).
    for (let i = 0; i < roster.length; i++) {
      if (i % 2 !== 0) continue;
      const st = roster[i];
      const correct = i % 4 === 0;
      await prisma.quizAttempt.create({
        data: {
          quizId: quiz.id,
          studentId: st.id,
          status: 'GRADED',
          answers: { [q1.id]: correct ? 'b' : 'a', [q2.id]: true },
          score: correct ? 2 : 1,
          maxScore: 2,
          submittedAt: new Date(),
        },
      });
    }
  }

  // --- A couple of message threads (teacher ↔ parent) ---
  const t0 = teachers[0].user.id;
  const p0 = parents[0].userId;
  const thread = await prisma.messageThread.create({
    data: { schoolId: sid, type: 'DIRECT' },
  });
  await prisma.threadParticipant.createMany({
    data: [
      { threadId: thread.id, userId: t0 },
      { threadId: thread.id, userId: p0 },
    ],
  });
  await prisma.message.create({
    data: {
      threadId: thread.id,
      senderId: t0,
      body: 'Hello, welcome to Demo Academy! Reach out with any questions.',
    },
  });

  // --- Announcements (school-wide) ---
  await prisma.announcement.createMany({
    data: [
      {
        schoolId: sid,
        authorUserId: admin.id,
        title: 'Welcome to the new term',
        body: 'Classes resume this week. Please check your schedules.',
        audienceScope: 'SCHOOL',
        publishAt: new Date(Date.now() - 86400000),
        publishedNotified: true,
      },
      {
        schoolId: sid,
        authorUserId: admin.id,
        title: 'Parent-teacher meeting',
        body: 'Scheduled for the end of the month. Details to follow.',
        audienceScope: 'SCHOOL',
        publishAt: new Date(Date.now() - 2 * 86400000),
        publishedNotified: true,
      },
    ],
  });

  console.log(`Seeded demo school ${CODE}:`);
  console.log(`  School admin: ${admin.email} / ${PASSWORD}`);
  console.log(`  Teachers: teacher1..3@demo-academy.test / ${PASSWORD}`);
  console.log(`  Parents: parent1..@demo-academy.test / ${PASSWORD}`);
  console.log(`  Students: student1..8@demo-academy.test / ${PASSWORD}`);
  console.log(
    `  ${attendanceRows.length} attendance rows, assignments/exams/quizzes/threads/announcements seeded.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
