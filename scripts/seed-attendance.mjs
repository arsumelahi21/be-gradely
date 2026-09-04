/**
 * Seed recent attendance for a school (dev data).
 *
 *   node scripts/seed-attendance.mjs            # last 30 days, Greenwood
 *   DAYS=90 SCHOOL="Demo Academy" node scripts/seed-attendance.mjs
 *
 * Seeds recent attendance so the dashboard chart has something to draw.
 * Weekdays only, last N days, skipping any (student, subject-class, date, period)
 * that already exists — safe to re-run.
 */
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

const DAYS = Number(process.env.DAYS ?? 30);
const SCHOOL = process.env.SCHOOL ?? 'Greenwood High School';

const school = await p.school.findFirst({ where: { name: SCHOOL }, select: { id: true, name: true } });
if (!school) throw new Error(`school not found: ${SCHOOL}`);

const marker = await p.user.findFirst({
  where: { schoolId: school.id, role: 'SCHOOL_ADMIN' },
  select: { id: true },
});
if (!marker) throw new Error('no SCHOOL_ADMIN to attribute the marks to');

// One roster per subject-class: the students actively enrolled in its section.
const subjectClasses = await p.sectionSubject.findMany({
  where: { section: { schoolId: school.id } },
  select: {
    id: true,
    subject: { select: { name: true } },
    section: { select: { name: true, classGrade: { select: { name: true } },
      enrollments: { where: { status: 'ACTIVE' }, select: { studentId: true } } } },
  },
});

const startOfUtcDay = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const today = startOfUtcDay(new Date());

// A per-day present rate that drifts between ~0.82 and ~0.97 rather than being
// flat, so the chart shows a real shape.
const rateFor = (i) => 0.9 + 0.07 * Math.sin(i / 1.7) - 0.02 * Math.cos(i / 3.1);

const rows = [];
for (let back = DAYS - 1; back >= 0; back--) {
  const date = new Date(today.getTime() - back * 86_400_000);
  const dow = date.getUTCDay();
  if (dow === 0 || dow === 6) continue; // no register at the weekend
  const target = rateFor(DAYS - back);

  for (const sc of subjectClasses) {
    const students = [...new Set(sc.section.enrollments.map((e) => e.studentId))];
    for (const studentId of students) {
      const r = Math.random();
      const status = r < target ? 'PRESENT' : r < target + 0.05 ? 'LATE' : r < target + 0.09 ? 'EXCUSED' : 'ABSENT';
      rows.push({ schoolId: school.id, studentId, sectionSubjectId: sc.id, period: 1, date, status, markedByUserId: marker.id });
    }
  }
}

console.log(`${school.name}: ${subjectClasses.length} subject-classes, ${rows.length} marks over ${DAYS} days`);
const res = await p.attendance.createMany({ data: rows, skipDuplicates: true });
console.log(`inserted ${res.count} (duplicates skipped)`);
await p.$disconnect();
