/**
 * One-off: set explicit referential actions on the FKs that were silently
 * defaulting to Restrict. Run once, then delete — the schema is the record.
 *
 *   node scripts/apply-ondelete.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const FILE = path.resolve('prisma/schema.prisma');
const check = process.argv.includes('--check');

/** [model, relationField, action] — the relation field, not the FK scalar. */
const CHANGES = [
  // --- Subject ------------------------------------------------------------
  ['SectionSubject', 'subject', 'Cascade'],
  ['TeacherSubjectSpecialty', 'subject', 'Cascade'],
  // --- Section ------------------------------------------------------------
  ['Enrollment', 'section', 'Cascade'],
  ['Quiz', 'section', 'Cascade'],
  ['SectionSubject', 'section', 'Cascade'],
  ['Timetable', 'section', 'Cascade'],
  ['TimetableEntry', 'section', 'Cascade'],
  // --- ClassGrade ---------------------------------------------------------
  ['Section', 'classGrade', 'Cascade'],
  // --- SectionSubject -----------------------------------------------------
  ['Attendance', 'sectionSubject', 'Cascade'],
  // --- StudentProfile -----------------------------------------------------
  ['Attendance', 'student', 'Cascade'],
  ['Challan', 'student', 'Cascade'],
  ['ParentStudent', 'student', 'Cascade'],
  ['QuizAttempt', 'student', 'Cascade'],
  // --- ParentProfile ------------------------------------------------------
  ['ParentStudent', 'parent', 'Cascade'],
  // --- AcademicYear -------------------------------------------------------
  ['Challan', 'academicYear', 'Cascade'],
  ['Enrollment', 'academicYear', 'Cascade'],
  ['FeeInstallmentPlan', 'academicYear', 'Cascade'],
  ['Timetable', 'academicYear', 'Cascade'],
  // --- Challan ------------------------------------------------------------
  ['Payment', 'challan', 'Cascade'],
  ['PaymentSubmission', 'challan', 'Cascade'],
  // --- User ---------------------------------------------------------------
  ['Announcement', 'author', 'Cascade'],
  ['Message', 'sender', 'Cascade'],
  ['ParentProfile', 'user', 'Cascade'],
  ['PaymentSubmission', 'submittedBy', 'Cascade'],
  ['Quiz', 'createdBy', 'Cascade'],
  // --- FeeInstallment -----------------------------------------------------
  // An issued challan is real money: it outlives the plan row it was billed
  // from, keeping the bill and losing only the pointer.
  ['Challan', 'installment', 'SetNull'],
];

const lines = readFileSync(FILE, 'utf8').split(/\r?\n/);
let model = null;
const applied = [];
const missed = new Set(CHANGES.map(([m, f]) => `${m}.${f}`));

for (let i = 0; i < lines.length; i++) {
  const t = lines[i].trim();
  const start = /^model\s+(\w+)\s*\{/.exec(t);
  if (start) {
    model = start[1];
    continue;
  }
  if (t === '}') {
    model = null;
    continue;
  }
  if (!model) continue;

  for (const [m, field, action] of CHANGES) {
    if (m !== model) continue;
    const re = new RegExp(`^(\\s*${field}\\s+\\w+\\??\\s+@relation\\()(.*)(\\)\\s*)$`);
    const hit = re.exec(lines[i]);
    if (!hit) continue;
    let args = hit[2];
    if (/onDelete\s*:/.test(args)) {
      args = args.replace(/onDelete\s*:\s*\w+/, `onDelete: ${action}`);
    } else {
      args = `${args.trimEnd().replace(/,$/, '')}, onDelete: ${action}`;
    }
    const next = `${hit[1]}${args}${hit[3]}`;
    if (next !== lines[i]) applied.push(`${model}.${field} -> ${action}`);
    lines[i] = next;
    missed.delete(`${m}.${field}`);
  }
}

console.log(`matched ${CHANGES.length - missed.size}/${CHANGES.length} relations`);
for (const a of applied) console.log('  ' + a);
if (missed.size) {
  console.log('\nNOT FOUND (fix the list before trusting this):');
  for (const m of missed) console.log('  ' + m);
  process.exit(1);
}
if (!check) {
  writeFileSync(FILE, lines.join('\n'));
  console.log('\nschema.prisma written');
} else {
  console.log('\n--check: nothing written');
}
