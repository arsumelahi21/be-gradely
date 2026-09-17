import { Role } from '../../common/types/role.type';
import type { ChatbotAppDataService } from '../app-data.service';
import type { ChatbotRequest } from './chatbot-provider.interface';
import { AppDataChatbotProvider } from './app-data-chatbot.provider';
import { DemoChatbotProvider } from './demo-chatbot.provider';

const ask = (question: string, role = Role.SCHOOL_ADMIN): ChatbotRequest => ({
  question,
  history: [],
  role,
  actor: { userId: 'u1', role, schoolId: 's1' },
});

const COUNTS = {
  counts: { students: 42, teachers: 5, parents: 40, classes: 6 },
  addedThisMonth: { students: 2, teachers: 0, parents: 1, classes: 0 },
};

/** Only the methods the provider calls; each test overrides what it needs. */
const stubData = (over: Record<string, unknown> = {}) =>
  ({
    counts: async () => ({ error: 'no' }),
    studentsByGrade: async () => ({ error: 'no' }),
    schoolAttendance: async () => ({ error: 'no' }),
    myClasses: async () => ({ error: 'no' }),
    outstandingFees: async () => ({ error: 'no' }),
    myTimetable: async () => ({ error: 'no' }),
    ...over,
  }) as unknown as ChatbotAppDataService;

describe('AppDataChatbotProvider', () => {
  const build = (over?: Record<string, unknown>) =>
    new AppDataChatbotProvider(stubData(over), new DemoChatbotProvider());

  it('answers from live data when an intent matches', async () => {
    const provider = build({ counts: async () => COUNTS });
    const reply = await provider.generateReply(
      ask('how many students do we have?'),
    );

    expect(reply.content).toContain('42');
    expect(reply.matched).toBe(true);
    expect(reply.topic).toBe('data.counts');
  });

  // Plural/singular must not decide whether a question is understood.
  it.each([
    'current count of students?',
    'student count',
    'total students',
    'what is the number of students',
    'how many teachers are there?',
  ])('understands the phrasing %p', async (question) => {
    const provider = build({ counts: async () => COUNTS });
    const reply = await provider.generateReply(ask(question));

    expect(reply.topic).toBe('data.counts');
  });

  it('breaks the roll down by class when asked', async () => {
    const provider = build({
      studentsByGrade: async () => ({
        grades: [
          {
            className: 'Grade 8',
            students: 30,
            sections: [
              { name: 'A', students: 16 },
              { name: 'B', students: 14 },
            ],
          },
        ],
      }),
    });
    const reply = await provider.generateReply(ask('divide them by grade'));

    expect(reply.topic).toBe('data.students-by-grade');
    expect(reply.content).toContain('Grade 8');
    expect(reply.content).toContain('A: 16');
  });

  // A refusal must degrade to guidance, never to an invented figure.
  it('falls back to the workflow guide when the lookup is refused', async () => {
    const provider = build({
      outstandingFees: async () => ({
        error: 'You do not have access to that.',
      }),
    });
    const reply = await provider.generateReply(ask('who owes fees?'));

    expect(reply.content).not.toMatch(/\bRs\b/);
    expect(reply.topic).not.toBe('data.outstanding');
  });

  it('still answers workflow questions the demo engine owns', async () => {
    const reply = await build().generateReply(ask('how do I mark attendance?'));

    expect(reply.matched).toBe(true);
    expect(reply.topic).toBe('attendance.mark');
  });

  // The product rule: app-level questions only. An unmatched question stays
  // unanswered rather than being improvised.
  it('refuses to answer an off-topic question', async () => {
    const reply = await build().generateReply(
      ask('what is the capital of France?'),
    );

    expect(reply.matched).toBe(false);
    expect(reply.content).toContain('demo mode');
  });

  it('passes the caller through as the actor, so scoping is the services own', async () => {
    let seen: ChatbotRequest['actor'] | null = null;
    const provider = build({
      myClasses: async (actor: ChatbotRequest['actor']) => {
        seen = actor;
        return { sections: [], overall: {} };
      },
    });
    await provider.generateReply(ask('what classes do I teach?', Role.TEACHER));

    expect(seen).toEqual({ userId: 'u1', role: Role.TEACHER, schoolId: 's1' });
  });
});
