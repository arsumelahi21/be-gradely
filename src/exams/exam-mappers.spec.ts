import {
  AudienceExaminationRow,
  cleanText,
  formatDate,
  formatMinutes,
  safePaperFileName,
  toAudienceExamination,
} from './exam-mappers';

// A row polluted with every paper-related field a careless select could pull in.
const pollutedRow = {
  id: 'x1',
  title: 'Mid Term Examination',
  instructions: 'Bring a calculator',
  status: 'PUBLISHED',
  resultStatus: 'IN_PROGRESS',
  publishedAt: new Date('2026-10-01'),
  finalizedAt: null,
  className: 'Grade 5',
  sectionName: 'A',
  schoolId: 'school-1',
  createdByUserId: 'teacher-user',
  reviewNote: 'internal note',
  academicYear: { id: 'y1', name: '2026-27' },
  term: { id: 't1', name: 'Term 1' },
  subjects: [
    {
      id: 'e1',
      heldAt: new Date('2026-10-12'),
      startMin: 540,
      endMin: 660,
      venue: 'Hall 2',
      maxScore: 100,
      passingMarks: 40,
      sectionSubject: { subject: { id: 's1', name: 'Mathematics' }, teacherId: 'tp1' },
      paper: { data: Buffer.from('%PDF-1.7 secret'), fileName: 'answers.pdf', sha256: 'abc', examId: 'e1' },
      paperId: 'e1',
      storageKey: 'school/papers/e1.pdf',
    },
  ],
} as unknown as AudienceExaminationRow;

describe('toAudienceExamination (student/parent response)', () => {
  const out = toAudienceExamination(pollutedRow);
  const json = JSON.stringify(out);

  it('never carries paper bytes, names, hashes, keys or ids', () => {
    for (const leak of ['paper', 'fileName', 'sha256', 'storageKey', 'secret', 'answers.pdf', '%PDF']) {
      expect(json).not.toContain(leak);
    }
  });

  it('drops internal staff fields', () => {
    for (const leak of ['schoolId', 'createdByUserId', 'reviewNote', 'internal note', 'teacherId']) {
      expect(json).not.toContain(leak);
    }
  });

  it('keeps the examination information students need', () => {
    expect(out).toMatchObject({
      title: 'Mid Term Examination',
      className: 'Grade 5',
      sectionName: 'A',
      academicYear: { name: '2026-27' },
      resultAvailable: false,
      subjects: [{ subject: { name: 'Mathematics' }, startMin: 540, endMin: 660, venue: 'Hall 2', maxScore: 100 }],
    });
  });

  it('hides the finalized date until results are finalized', () => {
    const finalized = toAudienceExamination({
      ...pollutedRow,
      resultStatus: 'FINALIZED',
      finalizedAt: new Date('2026-11-01'),
    } as AudienceExaminationRow);
    expect(finalized.resultAvailable).toBe(true);
    expect(finalized.finalizedAt).toEqual(new Date('2026-11-01'));
  });
});

describe('formatting helpers', () => {
  it('formats minutes and UTC dates', () => {
    expect(formatMinutes(540)).toBe('09:00');
    expect(formatMinutes(875)).toBe('14:35');
    expect(formatMinutes(null)).toBeNull();
    expect(formatDate(new Date('2026-10-12T00:00:00Z'))).toBe('12 Oct 2026');
  });

  it('trims text to null', () => {
    expect(cleanText('  ')).toBeNull();
    expect(cleanText(' Hall 2 ')).toBe('Hall 2');
  });

  it('makes uploaded file names safe for a header', () => {
    expect(safePaperFileName('C:\\fakepath\\Math "Final".PDF')).toBe('Math _Final_.pdf');
    expect(safePaperFileName('../../etc/passwd')).toBe('passwd.pdf');
    expect(safePaperFileName('')).toBe('exam-paper.pdf');
    expect(safePaperFileName('paper\r\nX-Evil: 1.pdf')).toBe('paper__X-Evil_ 1.pdf');
  });
});
