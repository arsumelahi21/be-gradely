import { Injectable } from '@nestjs/common';
import { ChatbotAppDataService } from '../app-data.service';
import {
  DemoChatbotProvider,
  scoreGroups,
  tokenize,
} from './demo-chatbot.provider';
import type {
  ChatbotProvider,
  ChatbotReply,
  ChatbotRequest,
} from './chatbot-provider.interface';

/**
 * Keyword engine over the real data — the no-API-key fallback, and the cheap
 * classifier in front of the model: greetings and off-topic questions are
 * answered here for zero tokens.
 *
 * It WRAPS `DemoChatbotProvider` rather than extending it, so that engine stays
 * pure and its promise — never invent school data — stays literally true.
 *
 * Deliberately NOT a general assistant: a question matching no data intent and
 * no workflow guide gets the demo fallback, which says so.
 */

interface DataIntent {
  topic: string;
  /** AND-groups, same convention as the demo engine: any group matching wins. */
  patterns: string[][];
  run: (
    data: ChatbotAppDataService,
    req: ChatbotRequest,
  ) => Promise<string | null>;
}

const DATA_INTENTS: DataIntent[] = [
  {
    topic: 'data.counts',
    patterns: [
      ['how', 'many', 'students'],
      ['how', 'many', 'teachers'],
      ['how', 'many', 'parents'],
      ['student', 'count'],
      ['teacher', 'count'],
      ['total', 'students'],
      ['number', 'students'],
      ['school', 'summary'],
      ['strength'],
    ],
    run: async (data, req) => {
      const r = await data.counts(req.actor);
      if ('error' in r) return null;
      const delta = (n: number) => (n > 0 ? ` (+${n} this month)` : '');
      return [
        `• **${r.counts.students}** students${delta(r.addedThisMonth.students)}`,
        `• **${r.counts.teachers}** teachers${delta(r.addedThisMonth.teachers)}`,
        `• **${r.counts.parents}** parents${delta(r.addedThisMonth.parents)}`,
        `• **${r.counts.classes}** classes${delta(r.addedThisMonth.classes)}`,
      ].join('\n');
    },
  },
  {
    topic: 'data.students-by-grade',
    patterns: [
      ['students', 'grade'],
      ['students', 'class'],
      ['divide', 'grade'],
      ['breakdown', 'class'],
      ['per', 'class'],
    ],
    run: async (data, req) => {
      const r = await data.studentsByGrade(req.actor);
      if ('error' in r) return null;
      if (!r.grades.length) return 'No classes have been created yet.';
      return r.grades
        .map(
          (g) =>
            `• **${g.className}** — ${g.students} student${g.students === 1 ? '' : 's'}` +
            (g.sections.length > 1
              ? ` (${g.sections.map((s) => `${s.name}: ${s.students}`).join(', ')})`
              : ''),
        )
        .join('\n');
    },
  },
  {
    topic: 'data.attendance',
    patterns: [
      ['attendance', 'today'],
      ['attendance', 'rate'],
      ['present', 'today'],
      ['how', 'attendance'],
    ],
    run: async (data, req) => {
      const r = await data.schoolAttendance(req.actor);
      if ('error' in r) return null;
      if (r.today.marksTotal === 0 && r.window.marksTotal === 0) {
        return 'No attendance has been marked in the last 30 days.';
      }
      const today =
        r.today.marksTotal === 0
          ? 'No attendance marked yet today.'
          : `**Today:** ${pct(r.today.presentRate)} present — ${r.today.marksPresent} present, ${r.today.marksAbsent} absent, ${r.today.marksLate} late.`;
      return `${today}\n\n**${r.window.from} → ${r.window.to}:** ${pct(r.window.presentRate)} present across ${r.window.marksTotal} marks.`;
    },
  },
  {
    topic: 'data.my-classes',
    patterns: [
      ['classes'],
      ['my', 'subjects'],
      ['what', 'teach'],
      ['do', 'teach'],
    ],
    run: async (data, req) => {
      const r = await data.myClasses(req.actor);
      if ('error' in r) return null;
      if (!r.sections.length) {
        return 'You have no subject-classes allocated yet. A school admin assigns these under the section’s subjects.';
      }
      const rows = r.sections.map((s) => {
        const where = `${s.className ?? ''} ${s.section}`.trim();
        const rate =
          s.marksTotal === 0
            ? 'no attendance marked'
            : `${pct(s.presentRate)} present`;
        return `• **${s.subject}** — ${where} (${rate})`;
      });
      return [
        `You teach **${r.sections.length}** subject-class${r.sections.length === 1 ? '' : 'es'}:`,
        '',
        ...rows,
      ].join('\n');
    },
  },
  {
    topic: 'data.outstanding',
    patterns: [
      ['who', 'owes'],
      ['outstanding', 'balance'],
      ['outstanding', 'fees'],
      ['pending', 'fees'],
      ['defaulters'],
    ],
    run: async (data, req) => {
      const r = await data.outstandingFees(req.actor, 5);
      if ('error' in r) return null;
      if (!r.students.length) {
        return 'Nothing outstanding — every issued challan is paid.';
      }
      const lines = r.students.map((s) => {
        const where = [s.className, s.sectionName].filter(Boolean).join(' ');
        const overdue =
          s.overdueChallans > 0 ? `, ${s.overdueChallans} overdue` : '';
        return `• **${s.fullName}**${where ? ` (${where})` : ''} — ${money(s.outstanding)} across ${s.challans} challan${s.challans === 1 ? '' : 's'}${overdue}`;
      });
      return [
        `Top ${r.students.length} by outstanding balance:`,
        '',
        ...lines,
      ].join('\n');
    },
  },
  {
    topic: 'data.timetable',
    patterns: [
      ['timetable', 'today'],
      ['schedule', 'today'],
      ['my', 'timetable'],
      ['next', 'class'],
    ],
    run: async (data, req) => {
      const today = DAY_NAMES[new Date().getUTCDay()];
      const r = await data.myTimetable(req.actor, today);
      if ('error' in r) return null;
      if (!r.entries.length) {
        return `Nothing scheduled for you today (${titleCase(today)}). A timetable only appears once it is **published**.`;
      }
      const rows = r.entries.map(
        (e) =>
          `• ${e.start}–${e.end}  **${e.subject ?? 'Class'}**` +
          (e.className
            ? ` — ${e.className} ${e.section ?? ''}`.trimEnd()
            : '') +
          (e.room ? ` (${e.room})` : ''),
      );
      return [`Your ${titleCase(today)}:`, '', ...rows].join('\n');
    },
  },
];

@Injectable()
export class AppDataChatbotProvider implements ChatbotProvider {
  readonly name = 'app-data';
  readonly isLive = false;

  constructor(
    private readonly data: ChatbotAppDataService,
    private readonly demo: DemoChatbotProvider,
  ) {}

  async generateReply(req: ChatbotRequest): Promise<ChatbotReply> {
    const terms = tokenize(req.question);

    let best: { intent: DataIntent; score: number } | null = null;
    for (const intent of DATA_INTENTS) {
      const score = scoreGroups(intent.patterns, terms);
      if (score > 0 && (!best || score > best.score)) best = { intent, score };
    }

    if (best) {
      const answer = await best.intent.run(this.data, req);
      // null = the asker's own API would refuse, or the lookup failed. Fall
      // through to guidance rather than guessing a number.
      if (answer) {
        return { content: answer, matched: true, topic: best.intent.topic };
      }
    }

    return this.demo.generateReply(req);
  }
}

const DAY_NAMES = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
];

const pct = (rate: number) => `${Math.round(rate * 100)}%`;

/** Money is Int minor units everywhere in this codebase (FEE_MODULE.md). */
const money = (minor: number) => `Rs ${(minor / 100).toLocaleString('en-PK')}`;

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
