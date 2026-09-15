import {
  assignPositions,
  DEFAULT_GRADE_BANDS as bands,
  gradeFor,
  percentOf,
  studentOutcome,
  subjectOutcome,
  SubjectMarkInput,
  summarizeClass,
  summarizeSubjects,
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

describe('percentOf / gradeFor', () => {
  it('rounds to two decimals and refuses a zero total', () => {
    expect(percentOf(425, 500)).toBe(85);
    expect(percentOf(2, 3)).toBe(66.67);
    expect(percentOf(5, 0)).toBeNull();
  });

  it('places every boundary in the higher band', () => {
    expect(gradeFor(90, bands)?.label).toBe('A+');
    expect(gradeFor(89.99, bands)?.label).toBe('A');
    expect(gradeFor(40, bands)?.label).toBe('E');
    expect(gradeFor(39.99, bands)?.label).toBe('F');
    expect(gradeFor(0, bands)?.label).toBe('F');
    expect(gradeFor(100, bands)?.label).toBe('A+');
  });

  it('does not depend on band order', () => {
    expect(gradeFor(72, [...bands].reverse())?.label).toBe('B');
  });
});

describe('validateBands', () => {
  it('accepts the default scheme', () => {
    expect(validateBands(bands)).toEqual([]);
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
});

describe('subjectOutcome', () => {
  it('passes on passing marks, not only the grade band', () => {
    expect(subjectOutcome(mark({ score: 40 }), bands)).toMatchObject({ state: 'PASS', grade: 'E', percentage: 40 });
    expect(subjectOutcome(mark({ score: 39 }), bands)).toMatchObject({ state: 'FAIL', grade: 'F' });
    expect(subjectOutcome(mark({ score: 45, passingMarks: 50 }), bands)).toMatchObject({ state: 'FAIL', grade: 'E' });
  });

  it('falls back to the band when no passing marks are set', () => {
    expect(subjectOutcome(mark({ score: 41, passingMarks: null }), bands).passed).toBe(true);
    expect(subjectOutcome(mark({ score: 39, passingMarks: null }), bands).passed).toBe(false);
  });

  it('flags missing, over-total, fractional and unset totals', () => {
    expect(subjectOutcome(mark({ score: null }), bands)).toMatchObject({ state: 'MISSING', issue: 'Marks not entered' });
    expect(subjectOutcome(mark({ score: 101 }), bands)).toMatchObject({ state: 'INVALID', issue: 'Marks must be between 0 and 100' });
    expect(subjectOutcome(mark({ score: 40.5 }), bands).state).toBe('INVALID');
    expect(subjectOutcome(mark({ maxScore: null }), bands)).toMatchObject({ state: 'INVALID', issue: 'Total marks not set' });
  });

  it('counts an absent student as failed with zero marks', () => {
    expect(subjectOutcome(mark({ isAbsent: true, score: null }), bands)).toMatchObject({
      state: 'ABSENT', obtained: 0, passed: false,
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
      complete: true, totalObtained: 425, totalMax: 500, percentage: 85, grade: 'A', passed: true, failedSubjects: [],
    });
  });

  it('fails overall when any single subject fails, even with a high average', () => {
    const r = studentOutcome([...five.slice(0, 4), mark({ examId: 'isl', label: 'Islamiat', score: 30 })], bands);
    expect(r).toMatchObject({ complete: true, passed: false, failedSubjects: ['Islamiat'] });
    expect(r.grade).toBe('B');
  });

  it('gives no percentage, grade or verdict while any mark is missing', () => {
    const r = studentOutcome([...five.slice(0, 4), mark({ examId: 'isl', score: null })], bands);
    expect(r).toMatchObject({ complete: false, percentage: null, grade: null, passed: null });
  });

  it('treats a student with no subjects as incomplete', () => {
    expect(studentOutcome([], bands).complete).toBe(false);
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
    studentOutcome([mark({ score: 90 }), mark({ examId: 'eng', label: 'English', score: 70 })], bands),
    studentOutcome([mark({ score: 30 }), mark({ examId: 'eng', label: 'English', score: 60 })], bands),
    studentOutcome([mark({ score: null }), mark({ examId: 'eng', label: 'English', isAbsent: true, score: null })], bands),
  ];

  it('summarizes the class over complete results only', () => {
    expect(summarizeClass(outcomes)).toEqual({
      totalStudents: 3, complete: 2, incomplete: 1, passed: 1, failed: 1,
      averagePercentage: 62.5, highestPercentage: 80, lowestPercentage: 45,
    });
  });

  it('summarizes each subject, counting absentees separately', () => {
    const [math, eng] = summarizeSubjects(outcomes);
    expect(math).toMatchObject({ label: 'Mathematics', entered: 2, passed: 1, failed: 1, absent: 0, averagePercentage: 60, highestScore: 90 });
    expect(eng).toMatchObject({ label: 'English', entered: 3, passed: 2, failed: 0, absent: 1, averagePercentage: 65, highestScore: 70 });
  });
});
