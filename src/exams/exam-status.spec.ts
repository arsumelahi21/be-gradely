import {
  adminCanEdit,
  canDelete,
  canEnterMarks,
  canFinalize,
  canReopen,
  ExaminationResultStatus as R,
  ExaminationStatus as S,
  nextStatus,
  paperIsEditable,
  submissionProblems,
  teacherCanEdit,
  ExaminationDraft,
  SubjectPaperDraft,
} from './exam-status';

const teacher = { teacherAuthored: true };
const admin = { teacherAuthored: false };

describe('nextStatus', () => {
  it('sends a draft or a returned proposal for review', () => {
    expect(nextStatus(S.DRAFT, 'SUBMIT', teacher)).toBe(S.PENDING_REVIEW);
    expect(nextStatus(S.CHANGES_REQUESTED, 'SUBMIT', teacher)).toBe(S.PENDING_REVIEW);
  });

  it('supports repeated review cycles', () => {
    let status = nextStatus(S.DRAFT, 'SUBMIT', teacher)!;
    status = nextStatus(status, 'REQUEST_CHANGES', teacher)!;
    status = nextStatus(status, 'SUBMIT', teacher)!;
    status = nextStatus(status, 'REQUEST_CHANGES', teacher)!;
    status = nextStatus(status, 'SUBMIT', teacher)!;
    expect(nextStatus(status, 'PUBLISH', teacher)).toBe(S.PUBLISHED);
  });

  it('only reviews a pending proposal', () => {
    for (const from of [S.DRAFT, S.CHANGES_REQUESTED, S.PUBLISHED, S.REJECTED]) {
      expect(nextStatus(from, 'REQUEST_CHANGES', admin)).toBeNull();
      expect(nextStatus(from, 'REJECT', admin)).toBeNull();
    }
    expect(nextStatus(S.PENDING_REVIEW, 'REJECT', admin)).toBe(S.REJECTED);
  });

  it('never publishes a teacher draft that skipped review', () => {
    expect(nextStatus(S.DRAFT, 'PUBLISH', teacher)).toBeNull();
    expect(nextStatus(S.DRAFT, 'PUBLISH', admin)).toBe(S.PUBLISHED);
  });

  it('treats published and rejected as terminal', () => {
    for (const action of ['SUBMIT', 'REQUEST_CHANGES', 'REJECT', 'PUBLISH'] as const) {
      expect(nextStatus(S.PUBLISHED, action, admin)).toBeNull();
      expect(nextStatus(S.REJECTED, action, admin)).toBeNull();
    }
  });
});

describe('edit permissions by status', () => {
  it('lets the teacher edit and replace papers only in draft or changes requested', () => {
    expect(teacherCanEdit(S.DRAFT)).toBe(true);
    expect(teacherCanEdit(S.CHANGES_REQUESTED)).toBe(true);
    expect(teacherCanEdit(S.PENDING_REVIEW)).toBe(false);
    expect(teacherCanEdit(S.PUBLISHED)).toBe(false);
    expect(paperIsEditable(S.PENDING_REVIEW)).toBe(false);
  });

  it('lets the principal edit during review but not after publication', () => {
    expect(adminCanEdit(S.PENDING_REVIEW)).toBe(true);
    expect(adminCanEdit(S.PUBLISHED)).toBe(false);
    expect(adminCanEdit(S.REJECTED)).toBe(false);
  });

  it('deletes only an unmarked draft', () => {
    expect(canDelete(S.DRAFT, false)).toBe(true);
    expect(canDelete(S.DRAFT, true)).toBe(false);
    expect(canDelete(S.PENDING_REVIEW, false)).toBe(false);
  });
});

describe('result gates', () => {
  it('opens marks entry only after publication and until finalization', () => {
    expect(canEnterMarks(S.PENDING_REVIEW, R.NOT_STARTED)).toBe(false);
    expect(canEnterMarks(S.PUBLISHED, R.NOT_STARTED)).toBe(true);
    expect(canEnterMarks(S.PUBLISHED, R.IN_PROGRESS)).toBe(true);
    expect(canEnterMarks(S.PUBLISHED, R.FINALIZED)).toBe(false);
  });

  it('finalizes once and reopens only a finalized result', () => {
    expect(canFinalize(S.PUBLISHED, R.IN_PROGRESS)).toBe(true);
    expect(canFinalize(S.PUBLISHED, R.FINALIZED)).toBe(false);
    expect(canReopen(R.FINALIZED)).toBe(true);
    expect(canReopen(R.IN_PROGRESS)).toBe(false);
  });
});

describe('submissionProblems', () => {
  const subject = (over: Partial<SubjectPaperDraft> = {}): SubjectPaperDraft => ({
    label: 'Mathematics',
    heldAt: new Date('2026-10-12'),
    startMin: 540,
    endMin: 660,
    maxScore: 100,
    passingMarks: 40,
    hasPaper: true,
    ...over,
  });
  const exam = (over: Partial<ExaminationDraft> = {}): ExaminationDraft => ({
    title: 'Mid Term Examination',
    academicYearId: 'y1',
    classGradeId: 'c1',
    sectionId: 's1',
    subjects: [subject()],
    ...over,
  });

  it('accepts a complete proposal', () => {
    expect(submissionProblems(exam())).toEqual([]);
  });

  it('requires title, session, class, section and a subject', () => {
    const problems = submissionProblems(
      exam({ title: '  ', academicYearId: null, classGradeId: null, sectionId: null, subjects: [] }),
    );
    expect(problems).toEqual([
      'Examination title is required',
      'Academic session is required',
      'Class is required',
      'Section is required',
      'Add at least one subject',
    ]);
  });

  it('requires the paper, date and valid marks per subject', () => {
    const problems = submissionProblems(
      exam({
        subjects: [
          subject({ hasPaper: false, heldAt: null, maxScore: 0, passingMarks: 5, endMin: 540 }),
        ],
      }),
    );
    expect(problems).toEqual([
      'Mathematics: exam date is required',
      'Mathematics: total marks must be greater than 0',
      'Mathematics: passing marks cannot exceed total marks',
      'Mathematics: end time must be after start time',
      'Mathematics: upload the exam paper (PDF)',
    ]);
  });
});
