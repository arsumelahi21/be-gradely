import {
  aggregateBySession,
  assignPositions,
  DEFAULT_GRADE_BANDS as bands,
  GradeBandInput,
  gradeForMarks,
  passMarkPercent,
  percentOf,
  studentOutcome,
  subjectOutcome,
  SubjectMarkInput,
  summarizeClass,
  summarizeSubjects,
  TermExamInput,
  termOutcome,
  termSubjectColumns,
  validateBands,
} from './result-calculator';

const mark = (over: Partial<SubjectMarkInput> = {}): SubjectMarkInput => ({
  examId: 'math',
  label: 'Mathematics',
  maxScore: 100,
  passingMarks: 40,
  score: 85,
  isAbsent: false,
  ...over,
});

/** A paper graded purely by its band (no passing marks), as in the worked examples. */
const paper = (
  label: string,
  score: number | null,
  maxScore: number,
  over: Partial<SubjectMarkInput> = {},
) =>
  mark({ examId: label, label, score, maxScore, passingMarks: null, ...over });

const grade = (obtained: number, total: number, b = bands) =>
  gradeForMarks(obtained, total, b)?.label;

/** One examination's outcome in the shape a term result consumes. */
const examOf = (
  examId: string,
  subjects: SubjectMarkInput[],
): TermExamInput => {
  const o = studentOutcome(subjects, bands);
  return {
    examId,
    complete: o.complete,
    totalObtained: o.totalObtained,
    totalMax: o.totalMax,
    passed: o.passed,
    subjects: o.subjects.map((s) => ({
      key: s.label,
      label: s.label,
      obtained: s.obtained,
      maxScore: s.maxScore,
      state: s.state,
      grade: s.grade,
      passed: s.passed,
    })),
  };
};

describe('a percentage uses the paper’s own total, never an assumed 100', () => {
  it.each([
    [46, 50, 92, 'A+'], // TEST 1
    [80, 100, 80, 'A'], // TEST 2
    [34, 100, 34, 'F'], // TEST 3
    [50, 50, 100, 'A+'], // TEST 5
    [0, 100, 0, 'F'], // TEST 6
    [40, 50, 80, 'A'], // TEST 7
    [30, 40, 75, 'B'],
    [18, 20, 90, 'A+'],
  ])('%i / %i = %d%% (%s)', (obtained, total, pct, label) => {
    expect(percentOf(obtained, total)).toBe(pct);
    expect(subjectOutcome(paper('S', obtained, total), bands)).toMatchObject({
      percentage: pct,
      grade: label,
    });
  });

  it('never produces NaN, Infinity or a value outside 0–100', () => {
    expect(percentOf(5, 0)).toBeNull();
    expect(percentOf(0, 0)).toBeNull();
    for (const [o, t] of [
      [0, 1],
      [1, 1],
      [999, 1000],
      [1, 7],
    ]) {
      const p = percentOf(o, t)!;
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(100);
    }
  });

  it('rounds half-up to 2dp from the exact fraction, free of float drift', () => {
    expect(percentOf(2, 3)).toBe(66.67);
    expect(percentOf(425, 500)).toBe(85);
    expect(percentOf(1, 800)).toBe(0.13); // 0.125
    expect(percentOf(3, 800)).toBe(0.38); // 0.375 — plain float rounding gives 0.37
  });
});

describe('an overall result adds marks, it does not average percentages', () => {
  it('TEST 4: 46/50 + 80/100 + 34/100 = 160/250 = 64%, not 68.67%', () => {
    const r = studentOutcome(
      [
        paper('Mathematics', 46, 50),
        paper('Islamiyat', 80, 100),
        paper('Biology', 34, 100),
      ],
      bands,
    );
    expect(r).toMatchObject({
      complete: true,
      totalObtained: 160,
      totalMax: 250,
      percentage: 64,
      grade: 'C',
    });
    expect(r.percentage).not.toBe(68.67);
  });

  it('TEST 15: 30/50 + 80/100 = 110/150 = 73.33%, not the 70% mean of 60% and 80%', () => {
    const r = studentOutcome(
      [paper('Mathematics', 30, 50), paper('English', 80, 100)],
      bands,
    );
    expect(r).toMatchObject({
      totalObtained: 110,
      totalMax: 150,
      percentage: 73.33,
      grade: 'B',
    });
  });

  it('never rounds before aggregating: 49/60 + 41/50 = 90/110 = 81.82%', () => {
    // Rounding each first (81.67%, 82%) and averaging would give 81.84%.
    const r = studentOutcome([paper('A', 49, 60), paper('B', 41, 50)], bands);
    expect(r.percentage).toBe(81.82);
  });

  it('handles very small and very large totals alike', () => {
    expect(
      studentOutcome([paper('Quiz', 1, 2), paper('Test', 1, 2)], bands)
        .percentage,
    ).toBe(50);
    expect(
      studentOutcome(
        Array.from({ length: 30 }, (_, i) => paper(`S${i}`, 999, 1000)),
        bands,
      ),
    ).toMatchObject({
      totalObtained: 29970,
      totalMax: 30000,
      percentage: 99.9,
    });
  });
});

describe('grade boundaries are decided on the exact fraction', () => {
  it.each([
    [7999, 10000, 'B'], // TEST 8: 79.99%
    [8000, 10000, 'A'], // TEST 9: 80%
    [8001, 10000, 'A'], // 80.01%
    [8999, 10000, 'A'], // TEST 10: 89.99%
    [9000, 10000, 'A+'], // TEST 11: 90%
    [9001, 10000, 'A+'],
    [3999, 10000, 'F'],
    [4000, 10000, 'E'],
    [4001, 10000, 'E'],
    [100, 100, 'A+'],
    [0, 100, 'F'],
  ])('%i / %i → %s', (obtained, total, label) => {
    expect(grade(obtained, total)).toBe(label);
  });

  it('does not promote a result that only ROUNDS up to a boundary', () => {
    // 79.995% displays as 80% but is below the A boundary.
    expect(percentOf(15999, 20000)).toBe(80);
    expect(grade(15999, 20000)).toBe('B');
    // 39.995% displays as 40% but is below the pass mark: it must fail.
    expect(percentOf(7999, 20000)).toBe(40);
    expect(grade(7999, 20000)).toBe('F');
    expect(subjectOutcome(paper('S', 7999, 20000), bands)).toMatchObject({
      grade: 'F',
      passed: false,
      state: 'FAIL',
    });
  });

  it('does not depend on band order and refuses a zero total', () => {
    expect(grade(72, 100, [...bands].reverse())).toBe('B');
    expect(gradeForMarks(5, 0, bands)).toBeNull();
  });
});

describe('validateBands', () => {
  const greenwood = (fPassing: boolean): GradeBandInput[] => [
    { label: 'A+', minPercent: 90, isPassing: true },
    { label: 'A', minPercent: 80, isPassing: true },
    { label: 'B', minPercent: 70, isPassing: true },
    { label: 'C', minPercent: 60, isPassing: true },
    { label: 'D', minPercent: 30, isPassing: true },
    { label: 'F', minPercent: 0, isPassing: fPassing },
  ];

  it('accepts the default scheme and a custom one with a lower pass mark', () => {
    expect(validateBands(bands)).toEqual([]);
    expect(validateBands(greenwood(false))).toEqual([]);
  });

  it('rejects gaps at 0, duplicates, out-of-range and no passing band', () => {
    const problems = validateBands([
      { label: 'A', minPercent: 80, isPassing: false },
      { label: 'a', minPercent: 80, isPassing: false },
      { label: 'Z', minPercent: 120, isPassing: false },
    ]);
    expect(problems).toEqual(
      expect.arrayContaining([
        'Two bands start at 80%',
        'Grade "a" is used twice',
        'Z: minimum % must be a whole number from 0 to 100',
        'One band must start at 0% so every score gets a grade',
        'At least one band must be passing',
      ]),
    );
  });

  it('rejects a scheme in which nothing can fail', () => {
    expect(validateBands(greenwood(true))).toContain(
      'At least one band must be failing, otherwise no score could ever fail',
    );
  });

  it('rejects a failing band above a passing one', () => {
    expect(
      validateBands([
        { label: 'A', minPercent: 80, isPassing: false },
        { label: 'B', minPercent: 50, isPassing: true },
        { label: 'F', minPercent: 0, isPassing: false },
      ]),
    ).toContain(
      'A failing band cannot sit above a passing one: passing grades must be the top grades',
    );
  });

  it('derives the pass mark from the scheme, never a constant', () => {
    expect(passMarkPercent(bands)).toBe(40);
    expect(passMarkPercent(greenwood(false))).toBe(30);
    expect(
      passMarkPercent([{ label: 'F', minPercent: 0, isPassing: false }]),
    ).toBeNull();
  });
});

describe('subjectOutcome', () => {
  it('passes on passing marks, not only the grade band', () => {
    expect(subjectOutcome(mark({ score: 40 }), bands)).toMatchObject({
      state: 'PASS',
      grade: 'E',
      percentage: 40,
    });
    expect(subjectOutcome(mark({ score: 39 }), bands)).toMatchObject({
      state: 'FAIL',
      grade: 'F',
    });
    expect(
      subjectOutcome(mark({ score: 45, passingMarks: 50 }), bands),
    ).toMatchObject({ state: 'FAIL', grade: 'E' });
  });

  it('falls back to the band when no passing marks are set', () => {
    expect(
      subjectOutcome(mark({ score: 41, passingMarks: null }), bands).passed,
    ).toBe(true);
    expect(
      subjectOutcome(mark({ score: 39, passingMarks: null }), bands).passed,
    ).toBe(false);
  });

  it('TEST 12–13: flags over-total, negative, fractional and unset totals as invalid', () => {
    expect(subjectOutcome(mark({ score: 101 }), bands)).toMatchObject({
      state: 'INVALID',
      percentage: null,
      grade: null,
      issue: 'Marks must be between 0 and 100',
    });
    expect(subjectOutcome(paper('S', 51, 50), bands).state).toBe('INVALID');
    expect(subjectOutcome(mark({ score: -5 }), bands).state).toBe('INVALID');
    expect(subjectOutcome(mark({ score: 40.5 }), bands).state).toBe('INVALID');
    expect(subjectOutcome(mark({ maxScore: null }), bands)).toMatchObject({
      state: 'INVALID',
      issue: 'Total marks not set',
    });
  });

  it('TEST 14: leaves unentered marks missing — never a silent zero', () => {
    expect(subjectOutcome(mark({ score: null }), bands)).toMatchObject({
      state: 'MISSING',
      obtained: null,
      percentage: null,
      grade: null,
      passed: null,
      issue: 'Marks not entered',
    });
  });

  it('counts an absent student as failed with zero marks', () => {
    expect(
      subjectOutcome(mark({ isAbsent: true, score: null }), bands),
    ).toMatchObject({
      state: 'ABSENT',
      obtained: 0,
      percentage: 0,
      grade: 'F',
      passed: false,
    });
  });
});

describe('studentOutcome', () => {
  const five = [
    mark({ examId: 'eng', label: 'English', score: 90 }),
    mark({ examId: 'math', label: 'Mathematics', score: 85 }),
    mark({ examId: 'sci', label: 'Science', score: 80 }),
    mark({ examId: 'urdu', label: 'Urdu', score: 88 }),
    mark({ examId: 'isl', label: 'Islamiat', score: 82 }),
  ];

  it('computes the PRD example: 425 / 500 = 85%, grade A, pass', () => {
    expect(studentOutcome(five, bands)).toMatchObject({
      complete: true,
      totalObtained: 425,
      totalMax: 500,
      percentage: 85,
      grade: 'A',
      passed: true,
      failedSubjects: [],
    });
  });

  it('TEST 17: fails overall when one subject fails, even with a passing overall %', () => {
    const r = studentOutcome(
      [
        paper('Mathematics', 90, 100),
        paper('Biology', 30, 100, { passingMarks: 40 }),
        paper('English', 80, 100),
      ],
      bands,
    );
    expect(r).toMatchObject({
      complete: true,
      totalObtained: 200,
      totalMax: 300,
      percentage: 66.67,
      grade: 'C',
      passed: false,
      failedSubjects: ['Biology'],
    });
  });

  it('TEST 18: an overall % in a failing band fails the result, even when every subject passes', () => {
    // Each paper clears its own 10-mark pass line, but 20% overall is an F: it cannot read "Pass".
    const r = studentOutcome(
      [
        paper('A', 15, 100, { passingMarks: 10 }),
        paper('B', 20, 100, { passingMarks: 10 }),
        paper('C', 25, 100, { passingMarks: 10 }),
      ],
      bands,
    );
    expect(r).toMatchObject({
      percentage: 20,
      grade: 'F',
      passed: false,
      belowPassMark: true,
      failedSubjects: [],
    });
  });

  it('gives no percentage, grade or verdict while any mark is missing', () => {
    const r = studentOutcome(
      [paper('Mathematics', 45, 50), paper('Biology', null, 100)],
      bands,
    );
    // 45/150 would treat the missing Biology paper as zero; it must not be computed.
    expect(r).toMatchObject({
      complete: false,
      percentage: null,
      grade: null,
      passed: null,
    });
  });

  it('treats a student with no subjects as incomplete', () => {
    expect(studentOutcome([], bands).complete).toBe(false);
  });

  it('is deterministic whatever order the subjects arrive in', () => {
    const forward = studentOutcome(five, bands);
    const backward = studentOutcome([...five].reverse(), bands);
    expect(backward).toMatchObject({
      totalObtained: forward.totalObtained,
      totalMax: forward.totalMax,
      percentage: forward.percentage,
      grade: forward.grade,
      passed: forward.passed,
    });
  });
});

describe('termOutcome — several examinations in one term', () => {
  it('TEST 16: combines exams by adding marks; no weights exist in the data model', () => {
    // 40/50 (80%) then 70/100 (70%): Σ = 110/150 = 73.33%. Not the 75% mean, nor a 30/70 split.
    const t = termOutcome(
      [
        examOf('mid', [paper('Mathematics', 40, 50)]),
        examOf('final', [paper('Mathematics', 70, 100)]),
      ],
      bands,
    );
    expect(t).toMatchObject({
      examCount: 2,
      complete: true,
      totalObtained: 110,
      totalMax: 150,
      percentage: 73.33,
      grade: 'B',
      passed: true,
    });
    expect(t.subjects).toEqual([
      {
        key: 'Mathematics',
        label: 'Mathematics',
        papers: 2,
        obtained: 110,
        maxScore: 150,
        isAbsent: false,
        missing: false,
        passed: true,
        grades: ['A', 'B'],
      },
    ]);
  });

  it('is incomplete, with no %, grade or verdict, while any examination is incomplete', () => {
    const t = termOutcome(
      [
        examOf('mid', [paper('Mathematics', 40, 50)]),
        examOf('final', [paper('Mathematics', null, 100)]),
      ],
      bands,
    );
    expect(t).toMatchObject({
      complete: false,
      percentage: null,
      grade: null,
      passed: null,
    });
    expect(t.subjects[0]).toMatchObject({
      obtained: 40,
      maxScore: 150,
      missing: true,
    });
  });

  it('counts an absence as zero and names the failed subject', () => {
    const t = termOutcome(
      [
        examOf('mid', [paper('Biology', 60, 100)]),
        examOf('final', [paper('Biology', null, 100, { isAbsent: true })]),
      ],
      bands,
    );
    expect(t).toMatchObject({
      complete: true,
      totalObtained: 60,
      totalMax: 200,
      percentage: 30,
      grade: 'F',
      passed: false,
      failedSubjects: ['Biology'],
    });
    expect(t.subjects[0]).toMatchObject({ isAbsent: true, passed: false });
  });

  it('fails a term whose % is a failing grade even if each examination passed on its own', () => {
    const passed = (examId: string, obtained: number): TermExamInput => ({
      examId,
      complete: true,
      totalObtained: obtained,
      totalMax: 100,
      passed: true,
      subjects: [],
    });
    expect(
      termOutcome([passed('a', 30), passed('b', 30)], bands),
    ).toMatchObject({
      percentage: 30,
      grade: 'F',
      passed: false,
      belowPassMark: true,
    });
    expect(
      termOutcome([passed('a', 60), passed('b', 40)], bands),
    ).toMatchObject({
      percentage: 50,
      passed: true,
      belowPassMark: false,
    });
  });

  it('matches the real Grade 6 A term: three single-subject exams, 46/50 + A + 34/100', () => {
    const t = termOutcome(
      [
        examOf('mid', [paper('Mathematics', 46, 50)]),
        examOf('isl', [
          paper('Islamiat', null, 100, { isAbsent: true, passingMarks: 40 }),
        ]),
        examOf('bio', [paper('Biology', 34, 100, { passingMarks: 40 })]),
      ],
      bands,
    );
    expect(t).toMatchObject({
      totalObtained: 80,
      totalMax: 250,
      percentage: 32,
      grade: 'F',
      passed: false,
      failedSubjects: ['Islamiat', 'Biology'],
    });
  });

  it('has nothing to say about an empty term', () => {
    expect(termOutcome([], bands)).toMatchObject({
      examCount: 0,
      complete: false,
      percentage: null,
    });
  });

  it('builds class-sheet columns once per subject with Σ paper totals', () => {
    expect(
      termSubjectColumns([
        {
          subjects: [
            { key: 'm', label: 'Mathematics', maxScore: 50 },
            { key: 'e', label: 'English', maxScore: 75 },
          ],
        },
        { subjects: [{ key: 'm', label: 'Mathematics', maxScore: 100 }] },
      ]),
    ).toEqual([
      { key: 'm', label: 'Mathematics', papers: 2, maxScore: 150 },
      { key: 'e', label: 'English', papers: 1, maxScore: 75 },
    ]);
  });
});

describe('aggregateBySession', () => {
  const y1 = { id: 'y1', name: '2025-2026' };
  const y2 = { id: 'y2', name: '2026-2027' };

  it('TEST 19–20: sums marks per session, newest first, never across sessions', () => {
    const sessions = aggregateBySession([
      {
        academicYear: y1,
        finalizedAt: '2026-03-01',
        totalObtained: 40,
        totalMax: 50,
        percentage: 80,
      },
      {
        academicYear: y2,
        finalizedAt: '2026-10-01',
        totalObtained: 70,
        totalMax: 100,
        percentage: 70,
      },
      {
        academicYear: y2,
        finalizedAt: '2026-12-01',
        totalObtained: 30,
        totalMax: 50,
        percentage: 60,
      },
      // Incomplete: totals but no percentage, so it contributes nothing.
      {
        academicYear: y2,
        finalizedAt: '2026-12-02',
        totalObtained: 10,
        totalMax: 100,
        percentage: null,
      },
    ]);
    expect(sessions).toEqual([
      {
        academicYear: y2,
        examCount: 2,
        totalObtained: 100,
        totalMax: 150,
        percentage: 66.67,
      },
      {
        academicYear: y1,
        examCount: 1,
        totalObtained: 40,
        totalMax: 50,
        percentage: 80,
      },
    ]);
  });
});

describe('assignPositions', () => {
  it('uses competition ranking and exact ties', () => {
    const positions = assignPositions([
      { studentId: 'a', totalObtained: 450, totalMax: 500, complete: true },
      { studentId: 'b', totalObtained: 90, totalMax: 100, complete: true },
      { studentId: 'c', totalObtained: 400, totalMax: 500, complete: true },
      { studentId: 'd', totalObtained: 499, totalMax: 500, complete: false },
    ]);
    expect(positions.get('a')).toBe(1);
    expect(positions.get('b')).toBe(1);
    expect(positions.get('c')).toBe(3);
    expect(positions.has('d')).toBe(false);
  });

  it('does not merge near-ties that only round equal', () => {
    const positions = assignPositions([
      { studentId: 'a', totalObtained: 2, totalMax: 3, complete: true },
      { studentId: 'b', totalObtained: 6667, totalMax: 10000, complete: true },
    ]);
    expect(positions.get('b')).toBe(1);
    expect(positions.get('a')).toBe(2);
  });
});

describe('class and subject summaries', () => {
  const outcomes = [
    studentOutcome(
      [
        mark({ score: 90 }),
        mark({ examId: 'eng', label: 'English', score: 70 }),
      ],
      bands,
    ),
    studentOutcome(
      [
        mark({ score: 30 }),
        mark({ examId: 'eng', label: 'English', score: 60 }),
      ],
      bands,
    ),
    studentOutcome(
      [
        mark({ score: null }),
        mark({ examId: 'eng', label: 'English', isAbsent: true, score: null }),
      ],
      bands,
    ),
  ];

  it('summarizes the class over complete results only', () => {
    expect(summarizeClass(outcomes)).toEqual({
      totalStudents: 3,
      complete: 2,
      incomplete: 1,
      passed: 1,
      failed: 1,
      averagePercentage: 62.5,
      highestPercentage: 80,
      lowestPercentage: 45,
    });
  });

  it('averages exact percentages, rounding once at the end', () => {
    // 2/3 and 1/3 are 66.666…% and 33.333…%: their exact mean is 50%.
    const thirds = [
      studentOutcome([paper('S', 2, 3)], bands),
      studentOutcome([paper('S', 1, 3)], bands),
    ];
    expect(summarizeClass(thirds).averagePercentage).toBe(50);
    expect(summarizeClass(thirds).highestPercentage).toBe(66.67);
  });

  it('summarizes each subject, counting absentees separately', () => {
    const [math, eng] = summarizeSubjects(outcomes);
    expect(math).toMatchObject({
      label: 'Mathematics',
      entered: 2,
      passed: 1,
      failed: 1,
      absent: 0,
      averagePercentage: 60,
      highestScore: 90,
    });
    expect(eng).toMatchObject({
      label: 'English',
      entered: 3,
      passed: 2,
      failed: 0,
      absent: 1,
      averagePercentage: 65,
      highestScore: 70,
    });
  });
});
