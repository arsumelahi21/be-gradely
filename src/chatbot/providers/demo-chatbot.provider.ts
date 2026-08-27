import { Injectable } from '@nestjs/common';
import { Role } from '../../common/types/role.type';
import type {
  ChatbotProvider,
  ChatbotReply,
  ChatbotRequest,
} from './chatbot-provider.interface';

/**
 * The DEMO answer engine. Pure, deterministic, no network, no key, no clock.
 *
 * It answers "how do I…" questions about real Gradely workflows by pointing at
 * real routes. It **never invents school data** — asked "who is absent today" it
 * explains where to look rather than naming students, because it has no access
 * to the database and pretending otherwise would be the worst possible demo bug.
 */

interface Intent {
  topic: string;
  /**
   * Each inner array is an AND-group; the intent matches if ANY group has all
   * its terms present. Longest satisfied group wins, so specific phrasings beat
   * generic ones without needing weights.
   */
  patterns: string[][];
  answer: string;
  /**
   * A school-admin-only workflow. Teachers get `teacherAnswer` instead — the
   * chatbot must not describe an action the API would refuse them.
   */
  adminOnly?: boolean;
  teacherAnswer?: string;
}

const NOT_YOURS =
  'That is a school-admin workflow — the fee endpoints are restricted to SCHOOL_ADMIN, so it will not appear in your portal.';

const INTENTS: Intent[] = [
  {
    topic: 'attendance.absent-today',
    patterns: [
      ['absent', 'today'],
      ['who', 'absent'],
      ['students', 'absent'],
      ['absentees'],
    ],
    answer: [
      "I can't read live attendance in demo mode, so I won't guess at names — here is where the real answer lives:",
      '',
      '• **Teachers** — *Attendance → Class Summary* shows a per-student present-rate for the period you pick, and each row opens a history drawer listing exactly which days were absent, late or excused.',
      '• **Today specifically** — the *Take Attendance* tab loads the roster for one date, so an unmarked or absent student is visible immediately.',
      '',
      'Attendance is anchored to a section-subject plus a date and period, so "absent today" is always scoped to a class period rather than the whole school.',
    ].join('\n'),
  },
  {
    topic: 'attendance.mark',
    patterns: [
      ['mark', 'attendance'],
      ['take', 'attendance'],
      ['record', 'attendance'],
    ],
    answer: [
      'Open **Attendance** in the teacher portal and use the *Take Attendance* tab.',
      '',
      '1. Pick the class/subject and the date.',
      '2. The roster loads with everyone defaulted to **Present** — you only touch the exceptions.',
      '3. Mark each exception as Absent, Late or Excused, then save.',
      '',
      'Saving is a bulk upsert, so re-marking the same date corrects the existing rows instead of duplicating them.',
    ].join('\n'),
  },
  {
    topic: 'fees.generate-challan',
    adminOnly: true,
    teacherAnswer: `Challan generation is not available to teachers. ${NOT_YOURS}`,
    patterns: [
      ['generate', 'challan'],
      ['create', 'challan'],
      ['issue', 'challan'],
      ['make', 'challan'],
      ['bill', 'students'],
    ],
    answer: [
      'Go to **Fee Management → Generate Challans**.',
      '',
      '1. Choose the academic year, then either **one section** or a whole **class** (a class run bills every active section in one go).',
      '2. Pick the billing month. The due date defaults from your school’s fee due-day setting and can be overridden.',
      '3. **Preview** first — it shows exactly who will be billed, who is skipped and why, and any arrears being carried forward.',
      '4. Generate.',
      '',
      'Two things happen automatically: students already billed for that month are skipped (a database constraint makes a duplicate impossible), and students on an **installment plan** are skipped too — they are billed through *Generate Installment Challan* instead, so nobody is billed twice for one month.',
    ].join('\n'),
  },
  {
    topic: 'fees.pending',
    adminOnly: true,
    teacherAnswer: `Fee balances are not visible in the teacher portal. ${NOT_YOURS}`,
    patterns: [
      ['pending', 'fees'],
      ['outstanding', 'fees'],
      ['unpaid', 'challan'],
      ['who', 'owes'],
      ['pending', 'payment'],
      ['defaulters'],
    ],
    answer: [
      "I can't read live balances in demo mode, but the numbers you want are two clicks away:",
      '',
      '• **Fee Management** landing page — *Outstanding* and *Overdue* cards give the totals at a glance.',
      '• **Fee Reports → Outstanding balances** — a ranked table of students and amounts, filterable by class, section, academic year or a date range. That is the list you act on.',
      '• **Generate Challans** — the challan list filters by status, so `UNPAID` and `PARTIALLY_PAID` give you the same set per month.',
      '',
      'Overdue is derived at read time from the due date and status, so it is never stale.',
    ].join('\n'),
  },
  {
    topic: 'fees.student-history',
    adminOnly: true,
    teacherAnswer: `Fee history is not visible in the teacher portal. ${NOT_YOURS}`,
    patterns: [
      ['student', 'fee', 'history'],
      ['fee', 'history'],
      ['past', 'challans'],
      ['payment', 'history'],
    ],
    answer: [
      'Open the student from **Students**, then use the fee section on their detail page. It shows every challan issued to them, what has been paid, the running balance, and their installment plan if they are on one.',
      '',
      'From there each challan opens its own detail page with the line items, the payment ledger and the print view. Line items are snapshots taken at generation, so an old challan keeps its original amounts even if the fee heads changed since.',
    ].join('\n'),
  },
  {
    topic: 'fees.installment-plan',
    adminOnly: true,
    teacherAnswer: `Installment plans are managed by the school admin. ${NOT_YOURS}`,
    patterns: [
      ['create', 'installment'],
      ['installment', 'plan'],
      ['setup', 'installment'],
      ['split', 'fee'],
      ['pay', 'installments'],
    ],
    answer: [
      'Open the student, then the **Installment Plan** panel.',
      '',
      '1. Enter the **total annual fee** and the **number of installments** (maximum 6).',
      '2. The schedule fills itself in — the amount is split evenly with any remainder on the last row, and due dates are generated for you.',
      '3. Adjust anything you like. Editing an amount or a date **locks that row**: later recalculations rebalance only the rows you have not touched, so a manual figure is never overwritten.',
      '4. Save.',
      '',
      'A plan is a schedule of promises, not a bill. Nothing is charged until you generate an installment challan for a specific row, and paid/unpaid status per installment is derived from the payment ledger rather than stored — so recording or voiding a payment updates the whole schedule with nothing to drift.',
    ].join('\n'),
  },
  {
    topic: 'fees.record-payment',
    adminOnly: true,
    teacherAnswer: `Recording payments is a school-admin action. ${NOT_YOURS}`,
    patterns: [
      ['record', 'payment'],
      ['add', 'payment'],
      ['mark', 'paid'],
      ['receive', 'payment'],
      ['enter', 'payment'],
    ],
    answer: [
      'Open the challan (**Fee Management → Generate Challans → the challan**) and use **Record Payment**. Enter the amount, method (cash, bank transfer, cheque, online or other), the date and an optional reference.',
      '',
      'The challan’s status recalculates from the ledger as soon as you save — part of the balance gives `PARTIALLY_PAID`, the full balance gives `PAID`. Overpayment is refused with the remaining balance in the error.',
      '',
      'Payments are append-only. A mistake is corrected by **voiding** the receipt, never by editing it, so the audit trail always shows what happened.',
    ].join('\n'),
  },
  {
    topic: 'fees.verify-receipt',
    adminOnly: true,
    teacherAnswer: `Receipt verification is a school-admin action. ${NOT_YOURS}`,
    patterns: [
      ['verify', 'payment'],
      ['verify', 'receipt'],
      ['approve', 'payment'],
      ['payment', 'verification'],
      ['online', 'receipt'],
    ],
    answer: [
      'Go to **Fee Management → Payment Verification**. It lists every receipt a parent or student has uploaded and is waiting on review; you can open the receipt image, then verify or reject it.',
      '',
      'Worth knowing: a submitted receipt is **evidence, not money**. Nothing touches the challan balance until you verify, and verification runs through the same payment-recording path as a cash payment — so there is exactly one way money can move.',
    ].join('\n'),
  },
  {
    topic: 'fees.reports',
    adminOnly: true,
    teacherAnswer: `Fee reports are a school-admin view. ${NOT_YOURS}`,
    patterns: [
      ['view', 'reports'],
      ['fee', 'reports'],
      ['collection', 'report'],
      ['see', 'reports'],
      ['collection', 'trend'],
    ],
    answer: [
      'Go to **Fee Management → Fee Reports**. One filter bar drives every panel — academic year, class, section, month, or a rolling window (week, fortnight, month, quarter, half-year, year) or a custom date range.',
      '',
      'You get: eight summary figures, collection over time, challans by status, class-wise collection, and a ranked outstanding-balances table. The filters live in the URL, so a filtered view is a shareable link.',
    ].join('\n'),
  },
  {
    topic: 'fees.add-fee-head',
    adminOnly: true,
    teacherAnswer: `Fee heads are configured by the school admin. ${NOT_YOURS}`,
    patterns: [
      ['add', 'fee', 'head'],
      ['create', 'fee', 'head'],
      ['fee', 'head'],
      ['new', 'fee', 'component'],
    ],
    answer: [
      'Go to **Fee Management → Settings → Fee Heads** and add one with a name and a default amount.',
      '',
      'A head is included in generation while it is **active**, so deactivating one stops it appearing on future challans without touching challans already issued — those hold their own snapshot of every line. If a particular student should pay a different amount, or none at all, set a per-student override on their profile instead of creating a second head.',
    ].join('\n'),
  },
  {
    topic: 'fees.print',
    adminOnly: true,
    teacherAnswer: `Challan printing is a school-admin action. ${NOT_YOURS}`,
    patterns: [
      ['print', 'challan'],
      ['print', 'challans'],
      ['challan', 'printout'],
    ],
    answer: [
      'A single challan prints from its detail page. A whole class prints in one action from the challan list — filter to the class and month, then use the bulk print view.',
      '',
      'The layout is A4 **landscape** with all three copies (bank, school, student) side by side on one sheet. Fully paid challans are skipped in a bulk print, and a paid one carries a PAID watermark driven by the server’s status.',
    ].join('\n'),
  },
  {
    topic: 'students.add',
    adminOnly: true,
    teacherAnswer:
      'Teachers cannot register students — that is a school-admin action. You can see the students in your own sections under **My Classes**.',
    patterns: [
      ['add', 'student'],
      ['register', 'student'],
      ['new', 'student'],
      ['admission'],
      ['enroll', 'student'],
    ],
    answer: [
      'Go to **Students → Add Student**.',
      '',
      'A few fields are required for a student and worth knowing up front: gender, date of birth, date of joining and the address fields; a **monthly fee** (`0` is a valid answer, blank is not); and exactly one guardian — either link an existing parent or create one inline. You can add more guardians afterwards from the edit form.',
      '',
      'Leave roll number and admission number blank and the server generates them for you. Enrolling the student in a class is a separate step after the account exists.',
    ].join('\n'),
  },
  {
    topic: 'announcements',
    patterns: [
      ['send', 'announcement'],
      ['post', 'announcement'],
      ['create', 'announcement'],
      ['announcement'],
    ],
    answer: [
      'Open **Announcements** and compose one. You choose the audience (the whole school, specific sections, or specific roles) and a type — urgent, important, general or event — and you can schedule it to publish later rather than immediately.',
      '',
      'Recipients see it in their portal and get a notification; you can see who has read or dismissed it.',
    ].join('\n'),
  },
  {
    topic: 'help',
    // No 'can' here — it is a stop word, so a group containing it never matches.
    patterns: [
      ['what', 'you', 'do'],
      ['help'],
      ['how', 'do', 'you', 'work'],
      ['capabilities'],
    ],
    answer: [
      "I'm the Gradely assistant, running in **demo mode** — I answer from a fixed set of workflow guides, and I have no connection to a live AI model or to your school's data.",
      '',
      'Things I can walk you through:',
      '',
      '• Generating challans, including for a whole class',
      '• Installment plans and installment challans',
      '• Recording payments and verifying uploaded receipts',
      '• Finding pending and overdue fees',
      '• A student’s fee history',
      '• Fee reports and fee heads',
      '• Marking attendance and reading the class summary',
      '• Registering a student, and posting announcements',
      '',
      'Ask in your own words — you do not need to phrase it the way I listed it.',
    ].join('\n'),
  },
  {
    topic: 'greeting',
    patterns: [['hello'], ['hi'], ['hey'], ['good', 'morning'], ['salam']],
    answer:
      "Hello. I'm the Gradely assistant, running in demo mode. Ask me how to do something in Gradely — generating challans, installment plans, recording a payment, attendance, reports — and I'll walk you through it. Try “what can you do?” for the full list.",
  },
];

const FALLBACK = [
  "I'm currently running in demo mode. I can help with common Gradely workflows, but this demo is not connected to a live AI model.",
  '',
  'Try asking about generating a challan, installment plans, recording a payment, pending fees, a student’s fee history, fee reports, fee heads, or attendance. Ask “what can you do?” for the full list.',
].join('\n');

@Injectable()
export class DemoChatbotProvider implements ChatbotProvider {
  readonly name = 'demo';
  readonly isLive = false;

  generateReply({ question, role }: ChatbotRequest): ChatbotReply {
    const terms = tokenize(question);
    if (terms.length === 0) return { content: FALLBACK, matched: false };

    let best: { intent: Intent; score: number } | null = null;
    for (const intent of INTENTS) {
      const score = scoreIntent(intent, terms);
      if (score > 0 && (!best || score > best.score)) best = { intent, score };
    }
    if (!best) return { content: FALLBACK, matched: false };

    const { intent } = best;
    // A teacher never gets walked through an endpoint their role would be
    // refused on — the guard is the boundary, but the answer shouldn't lie.
    const content =
      intent.adminOnly && role === Role.TEACHER && intent.teacherAnswer
        ? intent.teacherAnswer
        : intent.answer;

    return { content, matched: true, topic: intent.topic };
  }
}

/** Lowercase word list, punctuation stripped, trivial stop-words removed. */
function tokenize(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w));
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'be',
  'to',
  'of',
  'in',
  'on',
  'for',
  'my',
  'me',
  'i',
  'it',
  'this',
  'that',
  'please',
  'can',
  'could',
  'would',
  'should',
]);

/**
 * A group scores only if EVERY term in it is present; the score is that group's
 * length, so "add fee head" (3) beats a bare "fee head" (2) on the same input.
 */
function scoreIntent(intent: Intent, terms: string[]): number {
  let best = 0;
  for (const group of intent.patterns) {
    if (group.every((term) => terms.includes(term))) {
      best = Math.max(best, group.length);
    }
  }
  return best;
}
