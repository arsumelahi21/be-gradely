import {
  DestinationSection,
  PromotionPlanInput,
  PromotionRequest,
  SourceEnrollment,
  buildPromotionPlan,
  classNamePrefix,
  parseClassLevel,
  sectionKey,
  suggestNextClass,
  suggestSectionName,
} from './promotion-planner';

const SOURCE_YEAR = 'year-2025';
const TARGET_YEAR = 'year-2026';
const CLASS_6 = 'class-6';

function destination(
  id: string,
  name: string,
  classGradeId = CLASS_6,
): DestinationSection {
  return { id, name, classGradeId, label: `Grade 6 ${name}` };
}

function sectionsMap(...list: DestinationSection[]) {
  return new Map(list.map((s) => [sectionKey(s.classGradeId, s.name), s]));
}

function source(
  studentId: string,
  overrides: Partial<SourceEnrollment> = {},
): [string, SourceEnrollment] {
  return [
    studentId,
    {
      enrollmentId: `enr-${studentId}`,
      sectionId: 'sec-5a',
      label: 'Grade 5 A',
      ...overrides,
    },
  ];
}

function planInput(
  overrides: Partial<PromotionPlanInput> = {},
): PromotionPlanInput {
  const requests: PromotionRequest[] = overrides.requests ?? [
    {
      studentId: 's1',
      destinationClassGradeId: CLASS_6,
      destinationSectionName: 'A',
    },
  ];
  return {
    sourceAcademicYearId: SOURCE_YEAR,
    targetAcademicYearId: TARGET_YEAR,
    requests,
    sourceEnrollments: new Map([source('s1')]),
    targetEnrollments: [],
    existingSections: sectionsMap(destination('sec-6a', 'A')),
    studentNames: new Map([
      ['s1', 'Ayesha Khan'],
      ['s2', 'Bilal Ahmed'],
    ]),
    classNames: new Map([[CLASS_6, 'Grade 6']]),
    createMissingSections: false,
    ...overrides,
  };
}

describe('parseClassLevel', () => {
  it.each([
    ['Grade 5', 5],
    ['CLASS-10', 10],
    ['5', 5],
    ['Class 1 (Morning)', 1],
  ])('reads %s as %s', (name, expected) => {
    expect(parseClassLevel(name)).toBe(expected);
  });

  it('returns null when the name has no digits', () => {
    expect(parseClassLevel('Nursery')).toBeNull();
  });
});

describe('classNamePrefix', () => {
  it('strips digits and separators', () => {
    expect(classNamePrefix('Grade 5')).toBe('grade');
    expect(classNamePrefix('CLASS-10')).toBe('class');
    expect(classNamePrefix('KG-2')).toBe('kg');
  });
});

describe('suggestNextClass', () => {
  const classes = [
    { id: 'c5', name: 'Grade 5' },
    { id: 'c6', name: 'Grade 6' },
    { id: 'c7', name: 'Grade 7' },
    { id: 'kg2', name: 'KG-2' },
    { id: 'kg3', name: 'KG-3' },
  ];

  it('suggests one rung up', () => {
    expect(suggestNextClass({ id: 'c5', name: 'Grade 5' }, classes)?.id).toBe(
      'c6',
    );
  });

  it('stays on the same ladder — KG-2 must not become Grade 3', () => {
    expect(suggestNextClass({ id: 'kg2', name: 'KG-2' }, classes)?.id).toBe(
      'kg3',
    );
  });

  it('returns null for the top class', () => {
    expect(suggestNextClass({ id: 'c7', name: 'Grade 7' }, classes)).toBeNull();
  });

  it('returns null when the class name carries no level', () => {
    expect(suggestNextClass({ id: 'n', name: 'Nursery' }, classes)).toBeNull();
  });

  it('never suggests the class itself', () => {
    expect(
      suggestNextClass({ id: 'c6', name: 'Grade 6' }, [
        { id: 'c6', name: 'Grade 6' },
      ]),
    ).toBeNull();
  });
});

describe('suggestSectionName', () => {
  it('keeps the section letter, so 5-A maps to 6-A', () => {
    expect(suggestSectionName('A')).toBe('A');
  });
});

describe('buildPromotionPlan', () => {
  it('promotes into an existing destination section', () => {
    const plan = buildPromotionPlan(planInput());

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      studentId: 's1',
      outcome: 'PROMOTE',
      fromLabel: 'Grade 5 A',
      toLabel: 'Grade 6 A',
      destinationSectionId: 'sec-6a',
    });
    expect(plan.sectionsToCreate).toHaveLength(0);
    expect(plan.canExecute).toBe(true);
  });

  it('reuses a section that differs only in case — never a duplicate', () => {
    const plan = buildPromotionPlan(
      planInput({
        requests: [
          {
            studentId: 's1',
            destinationClassGradeId: CLASS_6,
            destinationSectionName: 'a',
          },
        ],
        createMissingSections: true,
      }),
    );

    expect(plan.items[0].destinationSectionId).toBe('sec-6a');
    expect(plan.sectionsToCreate).toHaveLength(0);
  });

  it('blocks when the destination section is missing and creation is off', () => {
    const plan = buildPromotionPlan(
      planInput({ existingSections: sectionsMap() }),
    );

    expect(plan.items[0].outcome).toBe('NO_DESTINATION');
    expect(plan.items[0].reason).toContain('Grade 6 A');
    expect(plan.canExecute).toBe(false);
  });

  it('queues the section once when creation is allowed', () => {
    const plan = buildPromotionPlan(
      planInput({
        requests: [
          {
            studentId: 's1',
            destinationClassGradeId: CLASS_6,
            destinationSectionName: 'B',
          },
          {
            studentId: 's2',
            destinationClassGradeId: CLASS_6,
            destinationSectionName: 'B',
          },
        ],
        sourceEnrollments: new Map([source('s1'), source('s2')]),
        createMissingSections: true,
      }),
    );

    expect(plan.sectionsToCreate).toEqual([
      {
        key: sectionKey(CLASS_6, 'B'),
        classGradeId: CLASS_6,
        name: 'B',
        label: 'Grade 6 B',
      },
    ]);
    expect(plan.items.every((i) => i.outcome === 'PROMOTE')).toBe(true);
    expect(plan.counts.PROMOTE).toBe(2);
  });

  it('drops a queued section when no student ends up needing it', () => {
    const plan = buildPromotionPlan(
      planInput({
        requests: [
          {
            studentId: 's1',
            destinationClassGradeId: CLASS_6,
            destinationSectionName: 'B',
          },
        ],
        // s1 already holds a place in the target session, so nothing is created.
        targetEnrollments: [
          {
            enrollmentId: 'enr-existing',
            studentId: 's1',
            sectionId: 'sec-6c',
            isActive: true,
            label: 'Grade 6 C',
          },
        ],
        createMissingSections: true,
      }),
    );

    expect(plan.items[0].outcome).toBe('ALREADY_PROMOTED');
    expect(plan.sectionsToCreate).toHaveLength(0);
  });

  it('prevents duplicate promotion when the student already holds the target session', () => {
    const plan = buildPromotionPlan(
      planInput({
        targetEnrollments: [
          {
            enrollmentId: 'enr-existing',
            studentId: 's1',
            sectionId: 'sec-6b',
            isActive: true,
            label: 'Grade 6 B',
          },
        ],
      }),
    );

    expect(plan.items[0].outcome).toBe('ALREADY_PROMOTED');
    expect(plan.items[0].reason).toContain('Grade 6 B');
    // Skippable, not blocking: re-running a finished promotion must be safe.
    expect(plan.canExecute).toBe(true);
    expect(plan.counts.ALREADY_PROMOTED).toBe(1);
  });

  it('reactivates a dormant row in the exact destination instead of duplicating it', () => {
    const plan = buildPromotionPlan(
      planInput({
        targetEnrollments: [
          {
            enrollmentId: 'enr-old',
            studentId: 's1',
            sectionId: 'sec-6a',
            isActive: false,
            label: 'Grade 6 A',
          },
        ],
      }),
    );

    expect(plan.items[0]).toMatchObject({
      outcome: 'REACTIVATE',
      reactivateEnrollmentId: 'enr-old',
      destinationSectionId: 'sec-6a',
    });
  });

  it('skips a student who is no longer enrolled in the source class', () => {
    const plan = buildPromotionPlan(
      planInput({ sourceEnrollments: new Map() }),
    );

    expect(plan.items[0].outcome).toBe('NOT_ENROLLED');
    expect(plan.canExecute).toBe(true);
  });

  describe('within one session (a demotion or a section move)', () => {
    const sameSession = (overrides: Partial<PromotionPlanInput> = {}) =>
      planInput({
        targetAcademicYearId: SOURCE_YEAR,
        classNames: new Map([[CLASS_6, 'Grade 5']]),
        existingSections: sectionsMap(destination('sec-5b', 'B')),
        requests: [
          {
            studentId: 's1',
            destinationClassGradeId: CLASS_6,
            destinationSectionName: 'B',
          },
        ],
        ...overrides,
      });

    it('does not read the source row as an existing promotion', () => {
      const plan = buildPromotionPlan(
        sameSession({
          // The source enrollment IS a target-session row when the sessions match.
          targetEnrollments: [
            {
              enrollmentId: 'enr-s1',
              studentId: 's1',
              sectionId: 'sec-5a',
              isActive: true,
              label: 'Grade 5 A',
            },
          ],
        }),
      );

      expect(plan.items[0].outcome).toBe('PROMOTE');
      expect(plan.items[0].destinationSectionId).toBe('sec-5b');
    });

    it('reports a move onto the current place as a no-op', () => {
      const plan = buildPromotionPlan(
        sameSession({
          existingSections: sectionsMap(destination('sec-5a', 'A')),
          requests: [
            {
              studentId: 's1',
              destinationClassGradeId: CLASS_6,
              destinationSectionName: 'A',
            },
          ],
        }),
      );

      expect(plan.items[0].outcome).toBe('SAME_PLACEMENT');
      expect(plan.canExecute).toBe(true);
    });
  });

  it('accepts an explicit section id', () => {
    const plan = buildPromotionPlan(
      planInput({
        requests: [
          {
            studentId: 's1',
            destinationClassGradeId: CLASS_6,
            destinationSectionId: 'sec-6a',
          },
        ],
      }),
    );

    expect(plan.items[0]).toMatchObject({
      outcome: 'PROMOTE',
      destinationSectionId: 'sec-6a',
    });
  });

  it('rejects a section id that belongs to a different class', () => {
    const plan = buildPromotionPlan(
      planInput({
        existingSections: sectionsMap(destination('sec-7a', 'A', 'class-7')),
        requests: [
          {
            studentId: 's1',
            destinationClassGradeId: CLASS_6,
            destinationSectionId: 'sec-7a',
          },
        ],
      }),
    );

    expect(plan.items[0].outcome).toBe('NO_DESTINATION');
    expect(plan.canExecute).toBe(false);
  });

  it('routes selected students to different destination sections', () => {
    const plan = buildPromotionPlan(
      planInput({
        existingSections: sectionsMap(
          destination('sec-6a', 'A'),
          destination('sec-6b', 'B'),
        ),
        sourceEnrollments: new Map([source('s1'), source('s2')]),
        requests: [
          {
            studentId: 's1',
            destinationClassGradeId: CLASS_6,
            destinationSectionName: 'A',
          },
          {
            studentId: 's2',
            destinationClassGradeId: CLASS_6,
            destinationSectionName: 'B',
          },
        ],
      }),
    );

    expect(plan.items.map((i) => i.destinationSectionId)).toEqual([
      'sec-6a',
      'sec-6b',
    ]);
  });

  // The section-reset step finds emptied sections from this field alone.
  it('reports the section each student is leaving', () => {
    const plan = buildPromotionPlan(
      planInput({
        sourceEnrollments: new Map([
          source('s1', { sectionId: 'sec-5a' }),
          source('s2', { sectionId: 'sec-5b' }),
        ]),
        requests: [
          {
            studentId: 's1',
            destinationClassGradeId: CLASS_6,
            destinationSectionName: 'A',
          },
          {
            studentId: 's2',
            destinationClassGradeId: CLASS_6,
            destinationSectionName: 'A',
          },
        ],
      }),
    );

    expect(plan.items.map((i) => i.sourceSectionId)).toEqual([
      'sec-5a',
      'sec-5b',
    ]);
  });

  it('reports no source section for a student who is not enrolled', () => {
    const plan = buildPromotionPlan(
      planInput({ sourceEnrollments: new Map() }),
    );

    expect(plan.items[0].outcome).toBe('NOT_ENROLLED');
    expect(plan.items[0].sourceSectionId).toBeNull();
  });

  it('collapses a student listed twice into one item', () => {
    const request: PromotionRequest = {
      studentId: 's1',
      destinationClassGradeId: CLASS_6,
      destinationSectionName: 'A',
    };
    const plan = buildPromotionPlan(
      planInput({ requests: [request, request] }),
    );

    expect(plan.items).toHaveLength(1);
    expect(plan.counts.PROMOTE).toBe(1);
  });
});
