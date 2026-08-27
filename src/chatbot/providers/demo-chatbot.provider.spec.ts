import { Role } from '../../common/types/role.type';
import { DemoChatbotProvider } from './demo-chatbot.provider';

/**
 * The demo engine is pure — no Prisma, no I/O, no clock — so it is tested
 * directly, the way `fee-calculator.spec.ts` tests the fee maths.
 */
describe('DemoChatbotProvider', () => {
  const provider = new DemoChatbotProvider();

  const ask = (question: string, role: Role = Role.SCHOOL_ADMIN) =>
    provider.generateReply({ question, history: [], role });

  it('declares itself as a non-live demo engine', () => {
    expect(provider.name).toBe('demo');
    expect(provider.isLive).toBe(false);
  });

  describe('the questions named in the brief', () => {
    const cases: Array<[string, string]> = [
      ['What students are absent today?', 'attendance.absent-today'],
      ['How do I generate a challan?', 'fees.generate-challan'],
      ['Which students have pending fees?', 'fees.pending'],
      ["How do I view a student's fee history?", 'fees.student-history'],
      ['How do I create an installment plan?', 'fees.installment-plan'],
      ['How do I record a payment?', 'fees.record-payment'],
      ['How do I view reports?', 'fees.reports'],
      ['How do I add a fee head?', 'fees.add-fee-head'],
    ];

    it.each(cases)('answers %j with the %s intent', (question, topic) => {
      const reply = ask(question);
      expect(reply.matched).toBe(true);
      expect(reply.topic).toBe(topic);
      expect(reply.content.length).toBeGreaterThan(40);
    });
  });

  it('matches regardless of casing and punctuation', () => {
    expect(ask('GENERATE CHALLAN!!!').topic).toBe('fees.generate-challan');
    expect(ask('how do i   generate a challan').topic).toBe(
      'fees.generate-challan',
    );
  });

  it('prefers the more specific intent when several match', () => {
    // "fee head" alone scores 2; "add fee head" scores 3 and must win.
    expect(ask('add a fee head').topic).toBe('fees.add-fee-head');
  });

  describe('honesty about being a demo', () => {
    it('falls back with the demo-mode notice for anything unknown', () => {
      const reply = ask('What is the capital of Sweden?');
      expect(reply.matched).toBe(false);
      expect(reply.content).toContain('demo mode');
      expect(reply.content).toContain('not connected to a live AI model');
    });

    it('falls back on an all-stop-word question rather than guessing', () => {
      expect(ask('the a of to').matched).toBe(false);
    });

    it('does not invent student data when asked who is absent', () => {
      const reply = ask('What students are absent today?');
      expect(reply.content).toMatch(/can't read live attendance/i);
      // It points at where to look instead of naming anybody.
      expect(reply.content).toMatch(/Class Summary/);
    });
  });

  describe('role-aware answers', () => {
    it('walks a school admin through an admin-only workflow', () => {
      const reply = ask('How do I record a payment?', Role.SCHOOL_ADMIN);
      expect(reply.content).toMatch(/Record Payment/);
    });

    it('tells a teacher the fee workflows are not theirs', () => {
      for (const q of [
        'How do I generate a challan?',
        'How do I record a payment?',
        'Which students have pending fees?',
        'How do I add a fee head?',
      ]) {
        const reply = provider.generateReply({
          question: q,
          history: [],
          role: Role.TEACHER,
        });
        expect(reply.matched).toBe(true);
        expect(reply.content).toMatch(/school.admin/i);
        // Never hand a teacher the click-path for something they'd be 403'd on.
        expect(reply.content).not.toMatch(/^\d\./m);
      }
    });

    it('answers attendance identically for both roles — it is not admin-only', () => {
      const admin = ask('How do I mark attendance?', Role.SCHOOL_ADMIN);
      const teacher = ask('How do I mark attendance?', Role.TEACHER);
      expect(teacher.content).toBe(admin.content);
      expect(teacher.topic).toBe('attendance.mark');
    });
  });

  it('leaves no unbalanced ** markers for the UI to render raw', () => {
    // The frontend turns `**bold**` into <strong> by splitting on this exact
    // pattern; an odd marker would show up as literal asterisks on screen.
    const questions = [
      'How do I generate a challan?',
      'How do I create an installment plan?',
      'How do I record a payment?',
      'What students are absent today?',
      'How do I mark attendance?',
      'How do I add a fee head?',
      'How do I view reports?',
      'Which students have pending fees?',
      'what can you do?',
      'hello',
      'something it cannot answer at all',
    ];

    for (const q of questions) {
      const parts = ask(q).content.split(/(\*\*[^*]+\*\*)/g);
      const plain = parts
        .filter((x) => !(x.startsWith('**') && x.endsWith('**')))
        .join('');
      expect({ q, plain: plain.includes('**') }).toEqual({ q, plain: false });
    }
  });

  it('introduces itself and lists what it can do', () => {
    expect(ask('hello').topic).toBe('greeting');
    const help = ask('what can you do?');
    expect(help.topic).toBe('help');
    expect(help.content).toContain('demo mode');
  });
});
