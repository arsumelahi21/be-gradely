/**
 * Comprehensive demo dataset for client demonstration.
 * Idempotent (safe to re-run) — creates only what's missing, keyed on natural
 * keys (school code, user email, grade/section/subject names).
 *
 *   DATABASE_URL=... node scripts/seed-demo-full.mjs
 *
 * Builds TWO schools, each with:
 *   - a school admin (principal)
 *   - an academic year (2026)
 *   - 3 grades × 2 sections
 *   - Mathematics / Science / English, each taught by a subject teacher
 *   - ~4 students per section, each linked to a parent (with relationship)
 *     + one parent with two children (siblings) to show multi-child parents
 * Plus sample activity: attendance for a week, a published quiz with graded
 * attempts, and a published assignment — so working features have real data.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const PW = {
  admin: 'School@12345678',
  teacher: 'Teacher@12345678',
  student: 'Student@12345',
  parent: 'Parent@12345',
};

// ---------- helpers ----------

async function ensureUser({ email, role, schoolId, password, fullName, phone }) {
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(password, 10),
        role,
        schoolId,
        isActive: true,
        ...(role === 'SCHOOL_ADMIN' || role === 'SUPER_ADMIN'
          ? { fullName, phone: phone ?? null }
          : {}),
      },
    });
  }
  return user;
}

async function ensureSchool(code, data) {
  let s = await prisma.school.findFirst({ where: { code } });
  if (!s) s = await prisma.school.create({ data: { code, ...data } });
  return s;
}

async function ensureAcademicYear(schoolId, name, code) {
  let ay = await prisma.academicYear.findFirst({ where: { schoolId, name } });
  if (!ay)
    ay = await prisma.academicYear.create({
      data: {
        schoolId,
        name,
        code,
        startDate: new Date('2026-01-01'),
        endDate: new Date('2026-12-31'),
        isActive: true,
      },
    });
  return ay;
}

async function ensureGrade(schoolId, name, code) {
  let g = await prisma.classGrade.findFirst({ where: { schoolId, name } });
  if (!g) g = await prisma.classGrade.create({ data: { schoolId, name, code } });
  return g;
}

async function ensureSection(schoolId, classGradeId, name) {
  let sec = await prisma.section.findFirst({ where: { classGradeId, name } });
  if (!sec)
    sec = await prisma.section.create({
      data: { schoolId, classGradeId, name },
    });
  return sec;
}

async function ensureSubject(schoolId, name, code) {
  let sub = await prisma.subject.findFirst({ where: { schoolId, name } });
  if (!sub) sub = await prisma.subject.create({ data: { schoolId, name, code } });
  return sub;
}

async function ensureSectionSubject(sectionId, subjectId, teacherId) {
  let ss = await prisma.sectionSubject.findFirst({
    where: { sectionId, subjectId },
  });
  if (!ss)
    ss = await prisma.sectionSubject.create({
      data: { sectionId, subjectId, teacherId },
    });
  else if (!ss.teacherId && teacherId)
    ss = await prisma.sectionSubject.update({
      where: { id: ss.id },
      data: { teacherId },
    });
  return ss;
}

async function ensureTeacher(schoolId, { email, fullName }) {
  const user = await ensureUser({
    email,
    role: 'TEACHER',
    schoolId,
    password: PW.teacher,
    fullName,
  });
  let profile = await prisma.teacherProfile.findUnique({
    where: { userId: user.id },
  });
  if (!profile)
    profile = await prisma.teacherProfile.create({
      data: { userId: user.id, schoolId, fullName },
    });
  return { user, profile };
}

let admissionSeq = {};
async function ensureStudent(school, { email, fullName, gender }) {
  const user = await ensureUser({
    email,
    role: 'STUDENT',
    schoolId: school.id,
    password: PW.student,
    fullName,
  });
  let profile = await prisma.studentProfile.findFirst({
    where: { userId: user.id },
  });
  if (!profile) {
    // Retry past any admission numbers already taken (existing students).
    for (let attempt = 0; attempt < 200 && !profile; attempt++) {
      admissionSeq[school.code] = (admissionSeq[school.code] ?? 0) + 1;
      const seq = admissionSeq[school.code];
      const admissionNo = `${school.code}-2026-${String(seq).padStart(4, '0')}`;
      // School-wide sequential roll number (unique per school, mirrors the
      // admission sequence) so demo rosters show populated roll numbers.
      const rollNo = String(seq).padStart(4, '0');
      try {
        profile = await prisma.studentProfile.create({
          data: {
            userId: user.id,
            schoolId: school.id,
            fullName,
            gender: gender ?? null,
            admissionNo,
            rollNo,
            dateOfJoining: new Date('2026-01-15'),
          },
        });
      } catch (e) {
        if (
          e.code === 'P2002' &&
          /admissionNo|rollNo/.test(String(e.meta?.target ?? ''))
        )
          continue;
        throw e;
      }
    }
  }
  return { user, profile };
}

async function ensureParent(school, { email, fullName, phone }) {
  const user = await ensureUser({
    email,
    role: 'PARENT',
    schoolId: school.id,
    password: PW.parent,
    fullName,
  });
  let profile = await prisma.parentProfile.findUnique({
    where: { userId: user.id },
  });
  if (!profile)
    profile = await prisma.parentProfile.create({
      data: { userId: user.id, fullName, phone: phone ?? null },
    });
  return { user, profile };
}

async function ensureEnrollment(studentId, sectionId, academicYearId) {
  const e = await prisma.enrollment.findFirst({
    where: { studentId, sectionId, academicYearId },
  });
  if (!e)
    await prisma.enrollment.create({
      data: { studentId, sectionId, academicYearId, status: 'ACTIVE' },
    });
}

async function linkParent(parentId, studentId, relationship) {
  await prisma.parentStudent.upsert({
    where: { parentId_studentId: { parentId, studentId } },
    update: { relationship },
    create: { parentId, studentId, relationship },
  });
}

// Teacher qualifications + subject specialty, keyed by subject.
const TEACHER_CREDS = {
  math: {
    specialty: { level: 'EXPERT', years: 8, notes: 'Algebra & geometry specialist.' },
    quals: [
      { title: 'M.Sc. Mathematics', institution: 'State University', year: 2012 },
      { title: 'B.Ed.', institution: 'City Teachers College', year: 2014 },
    ],
  },
  sci: {
    specialty: { level: 'INTERMEDIATE', years: 5, notes: 'Physics and general science.' },
    quals: [
      { title: 'B.Sc. Physics', institution: 'National Institute of Science', year: 2016 },
    ],
  },
  eng: {
    specialty: { level: 'EXPERT', years: 10, notes: 'Literature and composition.' },
    quals: [
      { title: 'M.A. English Literature', institution: 'Riverside University', year: 2010 },
      { title: 'TEFL Certification', institution: 'British Council', year: 2013 },
    ],
  },
};

async function ensureQualification(teacherId, q) {
  const ex = await prisma.teacherQualification.findFirst({
    where: { teacherId, title: q.title },
  });
  if (!ex)
    await prisma.teacherQualification.create({
      data: {
        teacherId,
        title: q.title,
        institution: q.institution,
        completionYear: q.year,
      },
    });
}

async function ensureSpecialty(teacherId, subjectId, sp) {
  const ex = await prisma.teacherSubjectSpecialty.findFirst({
    where: { teacherId, subjectId },
  });
  if (!ex)
    await prisma.teacherSubjectSpecialty.create({
      data: {
        teacherId,
        subjectId,
        expertiseLevel: sp.level,
        experienceYears: sp.years,
        notes: sp.notes,
      },
    });
}

async function addTeacherCredentials(teacherId, subjectId, key) {
  const c = TEACHER_CREDS[key];
  if (!c) return;
  await ensureSpecialty(teacherId, subjectId, c.specialty);
  for (const q of c.quals) await ensureQualification(teacherId, q);
}

// ---------- data ----------

const SCHOOLS = [
  {
    code: 'GHS',
    name: 'Greenwood High School',
    city: 'Springfield',
    admin: { email: 'principal@ghs.edu', fullName: 'Margaret Ellis' },
    teachers: [
      { key: 'math', email: 't.menon@ghs.edu', fullName: 'Ravi Menon' },
      { key: 'sci', email: 't.rao@ghs.edu', fullName: 'Sunita Rao' },
      { key: 'eng', email: 't.cole@ghs.edu', fullName: 'David Cole' },
    ],
    firstNames: ['Aarav', 'Diya', 'Kabir', 'Ananya', 'Vivaan', 'Isha', 'Reyansh', 'Sara', 'Arjun', 'Myra', 'Advait', 'Kiara'],
    lastNames: ['Kapoor', 'Sharma', 'Verma', 'Iyer', 'Nair', 'Gupta', 'Bose', 'Reddy', 'Khan', 'Malhotra', 'Chopra', 'Singh'],
  },
  {
    code: 'RVA',
    name: 'Riverside Academy',
    city: 'Riverton',
    admin: { email: 'principal@rva.edu', fullName: 'Thomas Wright' },
    teachers: [
      { key: 'math', email: 't.bennet@rva.edu', fullName: 'Laura Bennet' },
      { key: 'sci', email: 't.osei@rva.edu', fullName: 'Kwame Osei' },
      { key: 'eng', email: 't.silva@rva.edu', fullName: 'Marta Silva' },
    ],
    firstNames: ['Liam', 'Emma', 'Noah', 'Olivia', 'Ethan', 'Ava', 'Mason', 'Sophia', 'Lucas', 'Mia', 'Leo', 'Chloe'],
    lastNames: ['Turner', 'Brooks', 'Hayes', 'Ford', 'Reed', 'Coleman', 'Bishop', 'Dunn', 'Foster', 'Grant', 'Hale', 'Knight'],
  },
];

const GRADES = [
  { name: 'Grade 6', code: 'G6' },
  { name: 'Grade 7', code: 'G7' },
  { name: 'Grade 8', code: 'G8' },
];
const SECTION_NAMES = ['A', 'B'];
const SUBJECTS = [
  { name: 'Mathematics', code: 'MATH', teacher: 'math' },
  { name: 'Science', code: 'SCI', teacher: 'sci' },
  { name: 'English', code: 'ENG', teacher: 'eng' },
];
const STUDENTS_PER_SECTION = 4;

function slug(s) {
  return s.toLowerCase().replace(/[^a-z]/g, '');
}

// ---------- build ----------

async function build(def) {
  const school = await ensureSchool(def.code, {
    name: def.name,
    city: def.city,
    country: 'USA',
    isActive: true,
  });
  const domain = def.code.toLowerCase();

  await ensureUser({
    email: def.admin.email,
    role: 'SCHOOL_ADMIN',
    schoolId: school.id,
    password: PW.admin,
    fullName: def.admin.fullName,
  });

  const ay = await ensureAcademicYear(school.id, '2026', `${def.code}-AY-2026`);

  // teachers
  const teachers = {};
  for (const t of def.teachers) teachers[t.key] = await ensureTeacher(school.id, t);

  // subjects
  const subjects = {};
  for (const s of SUBJECTS)
    subjects[s.teacher] = await ensureSubject(school.id, s.name, s.code);

  // teacher qualifications + subject specialties
  for (const key of Object.keys(teachers))
    await addTeacherCredentials(teachers[key].profile.id, subjects[key].id, key);

  const sectionsBuilt = [];
  let studentIdx = 0;
  let parentIdx = 0;
  const sharedSiblingParents = []; // to demo a multi-child parent

  for (const g of GRADES) {
    const grade = await ensureGrade(school.id, g.name, `${def.code}-${g.code}`);
    for (const secName of SECTION_NAMES) {
      const section = await ensureSection(school.id, grade.id, secName);

      // subject-classes for this section
      const secSubjects = {};
      for (const s of SUBJECTS) {
        secSubjects[s.teacher] = await ensureSectionSubject(
          section.id,
          subjects[s.teacher].id,
          teachers[s.teacher].profile.id,
        );
      }

      // students + parents
      const students = [];
      for (let i = 0; i < STUDENTS_PER_SECTION; i++) {
        const fn = def.firstNames[studentIdx % def.firstNames.length];
        const ln = def.lastNames[studentIdx % def.lastNames.length];
        studentIdx++;
        const email = `${slug(fn)}.${slug(ln)}${studentIdx}@${domain}.edu`;
        const gender = i % 2 === 0 ? 'MALE' : 'FEMALE';
        const { profile: sp } = await ensureStudent(school, {
          email,
          fullName: `${fn} ${ln}`,
          gender,
        });
        await ensureEnrollment(sp.id, section.id, ay.id);

        // parent (first student of Grade 6-A and Grade 8-A share a parent = siblings)
        parentIdx++;
        const pEmail = `parent.${slug(ln)}${parentIdx}@${domain}.edu`;
        const { profile: pp } = await ensureParent(school, {
          email: pEmail,
          fullName: `${['Mr.', 'Mrs.'][i % 2]} ${ln}`,
          phone: '+1-555-0' + String(100 + parentIdx),
        });
        await linkParent(pp.id, sp.id, i % 2 === 0 ? 'FATHER' : 'MOTHER');

        if (g.name === 'Grade 6' && secName === 'A' && i === 0)
          sharedSiblingParents.push(pp);
        // sibling in Grade 8-A shares the Grade 6-A parent
        if (
          g.name === 'Grade 8' &&
          secName === 'A' &&
          i === 0 &&
          sharedSiblingParents[0]
        ) {
          await linkParent(sharedSiblingParents[0].id, sp.id, 'FATHER');
        }

        students.push(sp);
      }

      sectionsBuilt.push({ grade: g, section, secSubjects, students });
    }
  }

  return { school, ay, teachers, subjects, sectionsBuilt };
}

const ATT_DATES = [
  '2026-07-17',
  '2026-07-20',
  '2026-07-21',
  '2026-07-22',
  '2026-07-23',
];
// Deterministic score spread per student index (varied but reproducible).
const PCTS = [0.92, 0.78, 0.65, 0.85, 0.55];
const pct = (i) => PCTS[i % PCTS.length];
function gradeFromPct(p) {
  if (p >= 0.9) return 'A';
  if (p >= 0.8) return 'B';
  if (p >= 0.7) return 'C';
  if (p >= 0.6) return 'D';
  return 'F';
}

const QUIZ_QUESTIONS = [
  {
    type: 'MULTIPLE_CHOICE',
    text: 'What is 5 + 7?',
    options: [
      { id: 'a', text: '11' },
      { id: 'b', text: '12' },
      { id: 'c', text: '13' },
    ],
    correctAnswer: 'b',
    points: 1,
    order: 0,
  },
  {
    type: 'TRUE_FALSE',
    text: 'A triangle has three sides.',
    correctAnswer: true,
    points: 1,
    order: 1,
  },
  {
    type: 'MULTIPLE_CHOICE',
    text: 'Which of these is a prime number?',
    options: [
      { id: 'a', text: '4' },
      { id: 'b', text: '6' },
      { id: 'c', text: '7' },
    ],
    correctAnswer: 'c',
    points: 1,
    order: 2,
  },
];

async function markAttendance(school, sectionSubjectId, students, markedByUserId) {
  for (const d of ATT_DATES) {
    const date = new Date(d);
    for (let i = 0; i < students.length; i++) {
      let status = 'PRESENT';
      if (i === 1 && d === '2026-07-21') status = 'ABSENT';
      if (i === 2 && d === '2026-07-22') status = 'LATE';
      if (i === 3 && d === '2026-07-17') status = 'EXCUSED';
      await prisma.attendance.upsert({
        where: {
          studentId_sectionSubjectId_date_period: {
            studentId: students[i].id,
            sectionSubjectId,
            date,
            period: 1,
          },
        },
        update: { status },
        create: {
          schoolId: school.id,
          studentId: students[i].id,
          sectionSubjectId,
          period: 1,
          date,
          status,
          markedByUserId,
        },
      });
    }
  }
}

async function createQuizWithAttempts(school, section, ss, teacher, students, title, attemptCount) {
  if (await prisma.quiz.findFirst({ where: { sectionId: section.id, title } }))
    return;
  const quiz = await prisma.quiz.create({
    data: {
      schoolId: school.id,
      sectionId: section.id,
      subjectId: ss.subjectId,
      title,
      description: 'Auto-generated demo quiz.',
      durationMins: 15,
      isPublished: true,
      createdByUserId: teacher.user.id,
      questions: { create: QUIZ_QUESTIONS },
    },
    include: { questions: true },
  });
  for (let i = 0; i < Math.min(attemptCount, students.length); i++) {
    const answers = {};
    let score = 0;
    let max = 0;
    for (const q of quiz.questions) {
      max += q.points;
      if (q.type === 'TRUE_FALSE') {
        const ans = i % 3 === 2 ? !q.correctAnswer : q.correctAnswer;
        answers[q.id] = ans;
        if (Boolean(ans) === Boolean(q.correctAnswer)) score += q.points;
      } else {
        const correct = q.correctAnswer;
        const wrong = q.options.find((o) => o.id !== correct)?.id ?? correct;
        const ans = i % 2 === 0 ? correct : wrong;
        answers[q.id] = ans;
        if (ans === correct) score += q.points;
      }
    }
    await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        studentId: students[i].id,
        status: 'GRADED',
        answers,
        score,
        maxScore: max,
        submittedAt: new Date('2026-07-22T10:00:00Z'),
      },
    });
  }
}

async function createAssignment(school, ay, ss, teacher, title, description, dueAt, maxScore) {
  let a = await prisma.assignment.findFirst({
    where: { sectionSubjectId: ss.id, title },
  });
  if (!a)
    a = await prisma.assignment.create({
      data: {
        schoolId: school.id,
        academicYearId: ay.id,
        sectionSubjectId: ss.id,
        createdByTeacherId: teacher.profile.id,
        title,
        description,
        dueAt: new Date(dueAt),
        maxScore,
        status: 'PUBLISHED',
      },
    });
  return a;
}

async function submitAssignment(assignment, students, markedCount) {
  for (let i = 0; i < Math.min(markedCount, students.length); i++) {
    const st = students[i];
    if (
      await prisma.assignmentSubmission.findFirst({
        where: { assignmentId: assignment.id, studentId: st.id },
      })
    )
      continue;
    const score = Math.round((assignment.maxScore ?? 20) * pct(i));
    await prisma.assignmentSubmission.create({
      data: {
        assignmentId: assignment.id,
        studentId: st.id,
        status: 'MARKED',
        s3Key: `assignments/demo/${assignment.id}/${st.id}.pdf`,
        fileName: 'submission.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 12345,
        submittedAt: new Date('2026-07-21T09:00:00Z'),
        markedAt: new Date('2026-07-22T09:00:00Z'),
        score,
        remarks: 'Good work.',
      },
    });
  }
}

async function createExam(school, ay, ss, teacher, students, title, heldAt, maxScore, withResults) {
  if (await prisma.exam.findFirst({ where: { sectionSubjectId: ss.id, title } }))
    return;
  const exam = await prisma.exam.create({
    data: {
      schoolId: school.id,
      academicYearId: ay.id,
      sectionSubjectId: ss.id,
      createdByTeacherId: teacher.profile.id,
      title,
      heldAt: new Date(heldAt),
      maxScore,
      status: 'PUBLISHED',
    },
  });
  if (!withResults) return;
  const scored = students
    .map((st, i) => ({ st, score: Math.round(maxScore * pct(i)) }))
    .sort((a, b) => b.score - a.score);
  for (let r = 0; r < scored.length; r++) {
    const { st, score } = scored[r];
    await prisma.examResult.create({
      data: {
        examId: exam.id,
        studentId: st.id,
        score,
        grade: gradeFromPct(score / maxScore),
        rank: r + 1,
        remarks: r === 0 ? 'Top of the class!' : null,
        markedAt: new Date(heldAt),
      },
    });
  }
}

async function createDraftQuiz(school, section, ss, teacher, title) {
  if (await prisma.quiz.findFirst({ where: { sectionId: section.id, title } }))
    return;
  await prisma.quiz.create({
    data: {
      schoolId: school.id,
      sectionId: section.id,
      subjectId: ss.subjectId,
      title,
      description: 'Work in progress — not yet published to students.',
      durationMins: 20,
      isPublished: false, // DRAFT: only the teacher can see it
      createdByUserId: teacher.user.id,
      questions: { create: [QUIZ_QUESTIONS[0]] },
    },
  });
}

async function createDraftExam(school, ay, ss, teacher, title) {
  if (await prisma.exam.findFirst({ where: { sectionSubjectId: ss.id, title } }))
    return;
  await prisma.exam.create({
    data: {
      schoolId: school.id,
      academicYearId: ay.id,
      sectionSubjectId: ss.id,
      createdByTeacherId: teacher.profile.id,
      title,
      description: 'Draft — scheduling in progress.',
      maxScore: 40,
      status: 'DRAFT', // not yet published
    },
  });
}

async function addActivity({ school, ay, teachers, sectionsBuilt }) {
  for (const sec of sectionsBuilt) {
    const label = `${sec.grade.name} ${sec.section.name}`;
    const math = sec.secSubjects.math;
    const sci = sec.secSubjects.sci;
    const eng = sec.secSubjects.eng;
    const students = sec.students;

    // Authoring-workflow demo: one draft quiz + one draft exam in Grade 8-A.
    if (sec.grade.name === 'Grade 8' && sec.section.name === 'A') {
      await createDraftQuiz(
        school, sec.section, math, teachers.math,
        `Draft: Chapter 2 Quiz — ${label}`,
      );
      await createDraftExam(
        school, ay, math, teachers.math,
        `Draft: Unit Test — ${label}`,
      );
    }

    // Attendance — a full week for Math.
    await markAttendance(school, math.id, students, teachers.math.user.id);

    // Quiz — published; first 2 students completed (graded), rest can still take it.
    await createQuizWithAttempts(
      school, sec.section, math, teachers.math, students,
      `Math Quiz — ${label}`, 2,
    );

    // Assignments — one due (2 submitted+marked = completed, rest pending),
    // one upcoming (all pending).
    const a1 = await createAssignment(
      school, ay, math, teachers.math,
      `Math Worksheet — ${label}`, 'Complete problems 1–10.', '2026-07-20', 20,
    );
    await submitAssignment(a1, students, 2);
    await createAssignment(
      school, ay, eng, teachers.eng,
      `English Essay — ${label}`, 'Write a 300-word essay.', '2026-08-05', 25,
    );

    // Exams — a graded mid-term (results for all) and an upcoming final (no results).
    await createExam(
      school, ay, math, teachers.math, students,
      `Mid-Term Test — ${label}`, '2026-07-15', 50, true,
    );
    await createExam(
      school, ay, sci, teachers.sci, students,
      `Final Exam — ${label}`, '2026-08-20', 100, false,
    );
  }
}

/** Wipe all application data (keeps migration history) for a pristine demo. */
async function wipeAll() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(', ');
  if (list) {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`,
    );
  }
  // Recreate the super admin so the admin portal is usable after a wipe.
  await prisma.user.create({
    data: {
      email: 'superadmin@gradely.com',
      passwordHash: await bcrypt.hash('Admin@12345678', 10),
      role: 'SUPER_ADMIN',
      isActive: true,
      schoolId: null,
    },
  });
  console.log('Wiped existing data and recreated the super admin.\n');
}

async function main() {
  if (process.argv.includes('--wipe')) await wipeAll();

  const results = [];
  for (const def of SCHOOLS) {
    const built = await build(def);
    await addActivity(built);
    results.push(built);
  }

  console.log('\n✅ Demo dataset ready.\n');
  for (let i = 0; i < SCHOOLS.length; i++) {
    const def = SCHOOLS[i];
    const built = results[i];
    const studentCount = built.sectionsBuilt.reduce(
      (n, s) => n + s.students.length,
      0,
    );
    console.log(`■ ${def.name} (${def.code})`);
    console.log(`   Admin:    ${def.admin.email} / ${PW.admin}`);
    console.log(
      `   Teachers: ${def.teachers.map((t) => t.email).join(', ')}  (pw ${PW.teacher})`,
    );
    console.log(
      `   Grades:   ${GRADES.map((g) => g.name).join(', ')} × sections ${SECTION_NAMES.join('/')}`,
    );
    console.log(`   Students: ${studentCount} (pw ${PW.student}), each linked to a parent (pw ${PW.parent})`);
    // print a couple of sample student logins
    const sample = built.sectionsBuilt[0].students.slice(0, 2);
    for (const s of sample) {
      const u = await prisma.user.findFirst({ where: { studentProfile: { id: s.id } } });
      console.log(`     e.g. student: ${u?.email} / ${PW.student}`);
    }
    console.log(
      `   Activity (every section): 1 week attendance · a quiz (2 completed / rest available) · ` +
        `2 assignments (1 with graded submissions + pending, 1 upcoming) · a graded mid-term exam + an upcoming final.\n`,
    );
  }
  console.log('Super admin (all schools): superadmin@gradely.com / Admin@12345678\n');

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
