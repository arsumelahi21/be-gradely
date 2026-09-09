/**
 * One student, one class per academic year.
 *
 * The service enforces that on every new enrol, but rows written before the rule
 * existed are still there — this reports them and, with --apply, closes the
 * extras.
 *
 * It does NOT delete: extras are set INACTIVE, which is enough to free the
 * student (only ACTIVE rows hold a seat) while keeping the history and leaving
 * the change reversible. Attendance, results and challans keep pointing at rows
 * that still exist.
 *
 *   node scripts/dedupe-enrollments.mjs            # dry run — prints the plan
 *   node scripts/dedupe-enrollments.mjs --apply    # writes it
 *
 * Which placement survives: the NEWEST by createdAt, matching the rule the fee
 * roster and the picker already read by. Pass --keep=oldest to invert that.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
const keepOldest = process.argv.includes('--keep=oldest');

const rows = await prisma.enrollment.findMany({
  where: { status: 'ACTIVE' },
  orderBy: { createdAt: keepOldest ? 'asc' : 'desc' },
  select: {
    id: true,
    studentId: true,
    createdAt: true,
    academicYear: { select: { id: true, name: true } },
    student: { select: { fullName: true, schoolId: true } },
    section: {
      select: { name: true, classGrade: { select: { name: true } } },
    },
  },
});

const label = (r) =>
  `${r.section.classGrade?.name ?? ''} ${r.section.name}`.trim();

// Group by the pair the rule is scoped to.
const groups = new Map();
for (const r of rows) {
  const key = `${r.studentId}|${r.academicYear.id}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

const conflicts = [...groups.values()].filter((g) => g.length > 1);
const toClose = conflicts.flatMap((g) => g.slice(1));

console.log(
  `${rows.length} ACTIVE enrollments · ${conflicts.length} students in more than one class · ${toClose.length} rows to close`,
);
console.log(`keeping the ${keepOldest ? 'OLDEST' : 'NEWEST'} placement\n`);

for (const g of conflicts) {
  const [keep, ...drop] = g;
  console.log(`${keep.student.fullName}  [${keep.academicYear.name}]`);
  console.log(`   keep   ${label(keep)}`);
  for (const d of drop) console.log(`   close  ${label(d)}`);
}

if (!conflicts.length) {
  console.log('Nothing to do.');
} else if (!apply) {
  console.log(
    `\nDry run. Re-run with --apply to close ${toClose.length} rows.`,
  );
} else {
  const { count } = await prisma.enrollment.updateMany({
    where: { id: { in: toClose.map((r) => r.id) } },
    data: { status: 'INACTIVE' },
  });
  console.log(`\nClosed ${count} enrollment${count === 1 ? '' : 's'}.`);
}

await prisma.$disconnect();
