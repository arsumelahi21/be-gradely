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
  scheduleConflicts,
  ScheduledPaper,
  submissionProblems,
  teacherCanEdit,
  ExaminationDraft,
  SubjectPaperDraft,
  TERM_REQUIRED_MESSAGE,
} from './exam-status';

const teacher = { teacherAuthored: true };
const admin = { teacherAuthored: false };

describe('nextStatus', () => {
  it('sends a draft or a returned proposal for review', () => {
    expect(nextStatus(S.DRAFT, 'SUBMIT', teacher)).toBe(S.PENDING_REVIEW);
    expect(nextStatus(S.CHANGES_REQUESTED, 'SUBMIT', teacher)).toBe(
      S.PENDING_REVIEW,
    );
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
    for (const from of [
      S.DRAFT,
      S.CHANGES_REQUESTED,
      S.PUBLISHED,
      S.REJECTED,
    ]) {
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
    for (const action of [
      'SUBMIT',
      'REQUEST_CHANGES',
      'REJECT',
      'PUBLISH',
    ] as const) {
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
  const subject = (
    over: Partial<SubjectPaperDraft> = {},
  ): SubjectPaperDraft => ({
    id: 'e1',
    label: 'Mathematics',
    heldAt: new Date('2026-10-12'),
    startMin: 540,
    endMin: 660,
    venue: 'Hall 1',
    invigilatorTeacherId: 't1',
    maxScore: 100,
    passingMarks: 40,
    ...over,
  });
  const exam = (over: Partial<ExaminationDraft> = {}): ExaminationDraft => ({
    title: 'Mid Term Examination',
    academicYearId: 'y1',
    classGradeId: 'c1',
    sectionId: 's1',
    termId: 't1',
    subjects: [subject()],
    ...over,
  });
  const messages = (...args: Parameters<typeof submissionProblems>) =>
    submissionProblems(...args).map((i) => i.message);

  it('accepts a complete proposal', () => {
    expect(submissionProblems(exam())).toEqual([]);
    expect(submissionProblems(exam(), { forPublish: true })).toEqual([]);
  });

  it('requires title, session, class, section and a subject', () => {
    expect(
      messages(
        exam({
          title: '  ',
          academicYearId: null,
          classGradeId: null,
          sectionId: null,
          subjects: [],
        }),
      ),
    ).toEqual([
      'Examination title is required',
      'Academic session is required',
      'Class is required',
      'Section is required',
      'Add at least one subject',
    ]);
  });

  it('asks for a term only when the caller must have one', () => {
    // A teacher draft in a session with no terms stays valid; publishing never is.
    expect(submissionProblems(exam({ termId: null }))).toEqual([]);
    expect(messages(exam({ termId: null }), { requireTerm: true })).toEqual([
      TERM_REQUIRED_MESSAGE,
    ]);
    expect(submissionProblems(exam(), { requireTerm: true })).toEqual([]);
  });

  it('requires the date and valid marks per subject, never the exam paper', () => {
    const problems = submissionProblems(
      exam({
        subjects: [
          subject({
            heldAt: null,
            maxScore: 0,
            passingMarks: 5,
            endMin: 540,
          }),
        ],
      }),
    );
    expect(problems.map((p) => p.message)).toEqual([
      'Mathematics: exam date is required',
      'Mathematics: total marks must be greater than 0',
      'Mathematics: passing marks cannot exceed total marks',
      'Mathematics: end time must be after start time',
    ]);
    expect(problems.every((p) => p.subjectId === 'e1')).toBe(true);
  });

  it('never requires total marks — they are set at marks entry', () => {
    const noMarks = exam({
      subjects: [subject({ maxScore: null, passingMarks: null })],
    });
    expect(submissionProblems(noMarks)).toEqual([]);
    expect(submissionProblems(noMarks, { forPublish: true })).toEqual([]);
  });

  it('needs times, venue and invigilator only to publish', () => {
    const bare = exam({
      subjects: [
        subject({
          startMin: null,
          endMin: null,
          venue: '  ',
          invigilatorTeacherId: null,
        }),
      ],
    });
    expect(submissionProblems(bare)).toEqual([]);
    expect(messages(bare, { forPublish: true })).toEqual([
      'Mathematics: start time is required',
      'Mathematics: end time is required',
      'Mathematics: venue is required',
      'Mathematics: invigilator is required',
    ]);
  });
});

describe('scheduleConflicts', () => {
  const paper = (over: Partial<ScheduledPaper> = {}): ScheduledPaper => ({
    id: 'e1',
    label: 'Mathematics',
    heldAt: new Date('2027-06-14'),
    startMin: 540,
    endMin: 660,
    venue: 'Room 12',
    invigilatorTeacherId: 'teacherA',
    invigilatorName: 'Teacher A',
    examinationTitle: 'First Term Examination',
    sectionKey: 'sectionA:y1',
    ...over,
  });
  const otherSection = (over: Partial<ScheduledPaper> = {}) =>
    paper({
      id: 'b1',
      label: 'English',
      venue: 'Room 30',
      invigilatorTeacherId: 'teacherB',
      invigilatorName: 'Teacher B',
      examinationTitle: 'Grade 7 Term Exam',
      sectionKey: 'sectionB:y1',
      startMin: 600,
      endMin: 720,
      ...over,
    });

  it('blocks an invigilator booked elsewhere at an overlapping time', () => {
    const issues = scheduleConflicts(
      [paper()],
      [
        otherSection({
          invigilatorTeacherId: 'teacherA',
          invigilatorName: 'Teacher A',
        }),
      ],
    );
    expect(issues).toEqual([
      {
        subjectId: 'e1',
        message:
          'Mathematics: Teacher A is already assigned as an invigilator during this time (English, Grade 7 Term Exam)',
      },
    ]);
  });

  it('blocks a venue already occupied, ignoring case and spaces', () => {
    const issues = scheduleConflicts(
      [paper()],
      [otherSection({ venue: ' room 12 ' })],
    );
    expect(issues.map((i) => i.message)).toEqual([
      'Mathematics: Room 12 is already occupied during this time (English, Grade 7 Term Exam)',
    ]);
  });

  it('lets touching times, different days, invigilators and venues through', () => {
    const shared = { invigilatorTeacherId: 'teacherA', venue: 'Room 12' };
    expect(
      scheduleConflicts(
        [paper()],
        [
          otherSection({ ...shared, startMin: 660, endMin: 780 }),
          otherSection({ ...shared, heldAt: new Date('2027-06-15') }),
          otherSection(),
        ],
      ),
    ).toEqual([]);
  });

  it('blocks two overlapping papers for the same students', () => {
    const own = [
      paper(),
      paper({
        id: 'e2',
        label: 'Biology',
        startMin: 600,
        endMin: 720,
        venue: 'Lab',
        invigilatorTeacherId: 'teacherC',
      }),
    ];
    expect(scheduleConflicts(own, []).map((i) => i.subjectId)).toEqual([
      'e1',
      'e2',
    ]);
    expect(
      scheduleConflicts(
        [paper()],
        [otherSection({ sectionKey: 'sectionA:y1' })],
      ).map((i) => i.message),
    ).toEqual([
      'Mathematics: this section already has English, Grade 7 Term Exam at this time',
    ]);
  });

  it('ignores papers without a date or times', () => {
    expect(
      scheduleConflicts(
        [paper({ startMin: null })],
        [otherSection({ invigilatorTeacherId: 'teacherA' })],
      ),
    ).toEqual([]);
  });
});
