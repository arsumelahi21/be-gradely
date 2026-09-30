import { EnrollmentStatus, Prisma } from '@prisma/client';

type Db = Prisma.TransactionClient;

/**
 * Who actually takes a section-subject.
 *
 * Every caller passes the roster IT already resolved — attendance uses ACTIVE
 * only, exams use ACTIVE+COMPLETED minus transfers-out — and these helpers only
 * narrow it. A compulsory offering returns that roster minus anyone placed in a
 * sibling section who didn't pick it, so a regular class keeps its whole roster.
 *
 * A student's subjects may come from any section of their own class: a
 * StudentSubject row on another section's offering is how a student placed in
 * A1 takes Chemistry from A2. `crossSectionTakers` finds those students, since
 * no section roster lists them.
 */

/** Takers of each subject, in a handful of queries whatever the subject count. */
export async function takersBySubject(
  db: Db,
  sectionSubjectIds: string[],
  candidateStudentIds: string[],
  academicYearId: string,
): Promise<Map<string, ReadonlySet<string>>> {
  const takers = new Map<string, Set<string>>();
  if (!sectionSubjectIds.length) return takers;

  const offerings = await db.sectionSubject.findMany({
    where: { id: { in: sectionSubjectIds } },
    select: {
      id: true,
      isElective: true,
      sectionId: true,
      section: { select: { classGradeId: true } },
    },
  });
  // An id with no offering row is left out entirely, so a caller defaulting to
  // an empty set gets nobody rather than the whole class.
  for (const o of offerings) takers.set(o.id, new Set());
  if (!offerings.length || !candidateStudentIds.length) return takers;

  // Only a compulsory offering needs to know where each candidate sits: one
  // placed in a SIBLING section is on the roster for a pick, not for everything
  // this section teaches.
  const compulsory = offerings.filter((o) => !o.isElective);
  const placements = compulsory.length
    ? await db.enrollment.findMany({
        where: {
          studentId: { in: candidateStudentIds },
          academicYearId,
          section: {
            classGradeId: {
              in: [...new Set(compulsory.map((o) => o.section.classGradeId))],
            },
          },
        },
        select: {
          studentId: true,
          sectionId: true,
          status: true,
          section: { select: { classGradeId: true } },
        },
      })
    : [];
  const fromSibling = new Set<string>();
  for (const o of compulsory) {
    const placedHere = new Set<string>();
    const placedInSibling = new Set<string>();
    for (const p of placements) {
      if (p.section.classGradeId !== o.section.classGradeId) continue;
      if (p.sectionId === o.sectionId) placedHere.add(p.studentId);
      else if (p.status !== EnrollmentStatus.INACTIVE)
        placedInSibling.add(p.studentId);
    }
    const set = takers.get(o.id)!;
    for (const id of candidateStudentIds) {
      if (placedHere.has(id) || !placedInSibling.has(id)) set.add(id);
      else fromSibling.add(id);
    }
  }

  // Rows matter for every candidate of an elective, but for a compulsory
  // offering only for sibling-placed candidates — so a regular class with no
  // cross-section picks reads none.
  const anyElective = offerings.some((o) => o.isElective);
  if (!anyElective && !fromSibling.size) return takers;
  const chosen = await db.studentSubject.findMany({
    where: {
      sectionSubjectId: { in: offerings.map((o) => o.id) },
      academicYearId,
      studentId: {
        in: anyElective ? candidateStudentIds : [...fromSibling],
      },
    },
    select: { sectionSubjectId: true, studentId: true },
  });
  for (const row of chosen)
    takers.get(row.sectionSubjectId)?.add(row.studentId);
  return takers;
}

/** One subject's takers, keeping the caller's ordering. */
export async function narrowToTakers(
  db: Db,
  sectionSubjectId: string,
  candidateStudentIds: string[],
  academicYearId: string,
): Promise<string[]> {
  const takers = (
    await takersBySubject(
      db,
      [sectionSubjectId],
      candidateStudentIds,
      academicYearId,
    )
  ).get(sectionSubjectId);
  if (!takers) return [];
  return candidateStudentIds.filter((id) => takers.has(id));
}

/**
 * Students taking any of these offerings from a sibling section of their class:
 * they hold the row but are not placed in the offering's own section that year.
 * Callers add them to their section roster, then narrow per subject as usual.
 * A closed placement keeps its picks, so a pick counts only while the student
 * holds a placement in `statuses` in the offering's class.
 */
export async function crossSectionTakers(
  db: Db,
  sectionSubjectIds: string[],
  academicYearId: string,
  statuses: EnrollmentStatus[] = [EnrollmentStatus.ACTIVE],
): Promise<string[]> {
  if (!sectionSubjectIds.length) return [];
  const rows = await db.studentSubject.findMany({
    where: { sectionSubjectId: { in: sectionSubjectIds }, academicYearId },
    select: {
      studentId: true,
      sectionSubject: {
        select: {
          sectionId: true,
          section: { select: { classGradeId: true } },
        },
      },
    },
  });
  if (!rows.length) return [];
  const placements = await db.enrollment.findMany({
    where: {
      studentId: { in: [...new Set(rows.map((r) => r.studentId))] },
      academicYearId,
    },
    select: {
      studentId: true,
      sectionId: true,
      status: true,
      section: { select: { classGradeId: true } },
    },
  });
  // Only an open placement counts as "placed here": a student who left this
  // section can still pick its subject from a sibling. A history caller loses
  // nobody by it — its own roster already holds the closed placements.
  const placedHere = new Set(
    placements
      .filter((p) => p.status === EnrollmentStatus.ACTIVE)
      .map((p) => `${p.studentId}:${p.sectionId}`),
  );
  const openIn = new Set(
    placements
      .filter((p) => statuses.includes(p.status))
      .map((p) => `${p.studentId}:${p.section.classGradeId}`),
  );
  return [
    ...new Set(
      rows
        .filter(
          (r) =>
            !placedHere.has(`${r.studentId}:${r.sectionSubject.sectionId}`) &&
            openIn.has(
              `${r.studentId}:${r.sectionSubject.section.classGradeId}`,
            ),
        )
        .map((r) => r.studentId),
    ),
  ];
}

/**
 * The sections a student reaches through picks from sibling sections, as
 * `{ sectionId, academicYearId }` pairs — so anything a student sees "for their
 * section" also covers the section each of their subjects actually comes from.
 * As with `crossSectionTakers`, only a placement in `statuses` in the pick's
 * class that session counts.
 */
export async function crossSectionPlacements(
  db: Db,
  studentIds: string[],
  statuses: EnrollmentStatus[],
  academicYearId?: string,
): Promise<{ studentId: string; sectionId: string; academicYearId: string }[]> {
  if (!studentIds.length) return [];
  const [rows, placements] = await Promise.all([
    db.studentSubject.findMany({
      where: {
        studentId: { in: studentIds },
        ...(academicYearId && { academicYearId }),
      },
      select: {
        studentId: true,
        academicYearId: true,
        sectionSubject: {
          select: {
            sectionId: true,
            section: { select: { classGradeId: true } },
          },
        },
      },
    }),
    db.enrollment.findMany({
      where: {
        studentId: { in: studentIds },
        ...(academicYearId && { academicYearId }),
      },
      select: {
        studentId: true,
        sectionId: true,
        academicYearId: true,
        status: true,
        section: { select: { classGradeId: true } },
      },
    }),
  ]);
  const placed = new Set(
    placements
      .filter((p) => statuses.includes(p.status))
      .map((p) => `${p.studentId}:${p.sectionId}:${p.academicYearId}`),
  );
  const open = new Set(
    placements
      .filter((p) => statuses.includes(p.status))
      .map(
        (p) => `${p.studentId}:${p.section.classGradeId}:${p.academicYearId}`,
      ),
  );
  const out = new Map<
    string,
    { studentId: string; sectionId: string; academicYearId: string }
  >();
  for (const r of rows) {
    const key = `${r.studentId}:${r.sectionSubject.sectionId}:${r.academicYearId}`;
    if (placed.has(key) || out.has(key)) continue;
    const classKey = `${r.studentId}:${r.sectionSubject.section.classGradeId}:${r.academicYearId}`;
    if (!open.has(classKey)) continue;
    out.set(key, {
      studentId: r.studentId,
      sectionId: r.sectionSubject.sectionId,
      academicYearId: r.academicYearId,
    });
  }
  return [...out.values()];
}

/**
 * Whether a student not placed in an offering's section still sits it that
 * year, by a pick from a sibling section. The row alone is not enough: a
 * placement that closed keeps its choices, and those must not reopen access —
 * so the placement must be open, and in the offering's class.
 */
export async function picksFromSibling(
  db: Db,
  studentId: string,
  sectionSubjectId: string,
  academicYearId: string,
  statuses: EnrollmentStatus[] = [EnrollmentStatus.ACTIVE],
): Promise<boolean> {
  const row = await db.studentSubject.findFirst({
    where: {
      studentId,
      sectionSubjectId,
      academicYearId,
      student: {
        enrollments: {
          some: {
            academicYearId,
            status: { in: statuses },
            section: {
              classGrade: {
                sections: {
                  some: { subjects: { some: { id: sectionSubjectId } } },
                },
              },
            },
          },
        },
      },
    },
    select: { id: true },
  });
  return !!row;
}

/**
 * The section-subjects one student takes in a placement: every compulsory one
 * of their section, plus their own picks — which may come from any section of
 * the same class.
 */
export async function subjectsOf(
  db: Db,
  studentId: string,
  sectionId: string,
  academicYearId: string,
): Promise<Set<string>> {
  const [compulsory, chosen] = await Promise.all([
    db.sectionSubject.findMany({
      where: { sectionId, isElective: false },
      select: { id: true },
    }),
    db.studentSubject.findMany({
      where: {
        studentId,
        academicYearId,
        sectionSubject: {
          section: { classGrade: { sections: { some: { id: sectionId } } } },
        },
      },
      select: { sectionSubjectId: true },
    }),
  ]);
  return new Set([
    ...compulsory.map((o) => o.id),
    ...chosen.map((r) => r.sectionSubjectId),
  ]);
}

/**
 * Subjects each student already has marks or attendance in this session.
 * Whether a mid-session change may drop them is an open business rule, so
 * callers keep those subjects rather than removing them.
 */
export async function recordedSubjects(
  db: Db,
  studentIds: string[],
  sectionSubjectIds: string[],
  year: { id: string; startDate: Date; endDate: Date },
): Promise<Map<string, Set<string>>> {
  const recorded = new Map<string, Set<string>>();
  if (!studentIds.length || !sectionSubjectIds.length) return recorded;
  const [marked, attended] = await Promise.all([
    db.examResult.findMany({
      where: {
        studentId: { in: studentIds },
        exam: {
          sectionSubjectId: { in: sectionSubjectIds },
          academicYearId: year.id,
        },
      },
      select: {
        studentId: true,
        exam: { select: { sectionSubjectId: true } },
      },
    }),
    // Attendance carries no session and a section keeps its subjects across
    // sessions, so only the session's dates keep last year's rows out.
    db.attendance.groupBy({
      by: ['studentId', 'sectionSubjectId'],
      where: {
        studentId: { in: studentIds },
        sectionSubjectId: { in: sectionSubjectIds },
        date: { gte: year.startDate, lte: year.endDate },
      },
    }),
  ]);
  for (const { studentId, sectionSubjectId } of [
    ...marked.map((m) => ({ studentId: m.studentId, ...m.exam })),
    ...attended,
  ]) {
    recorded.set(
      studentId,
      (recorded.get(studentId) ?? new Set()).add(sectionSubjectId),
    );
  }
  return recorded;
}

/**
 * The default for a new placement, or for a subject newly opened to student
 * selection: the student takes every selectable subject until an admin unticks
 * it. A regular section has none, so nothing is written for it.
 *
 * A reopened placement keeps its choices rather than having unticked subjects
 * ticked again — unless another placement in the class came between.
 */
export async function selectAllElectives(
  db: Db,
  placements: {
    studentId: string;
    sectionId: string;
    academicYearId: string;
  }[],
  onlySectionSubjectIds?: string[],
): Promise<void> {
  if (!placements.length) return;
  const keyOf = (p: {
    studentId: string;
    sectionId: string;
    academicYearId: string;
  }) => `${p.studentId}:${p.sectionId}:${p.academicYearId}`;
  const fresh = new Set<string>();
  if (!onlySectionSubjectIds) {
    // A placement opening after another in the same class and session starts
    // fresh: the class's rows were that earlier placement's picks, not these.
    const sectionIds = [...new Set(placements.map((p) => p.sectionId))];
    const [sections, earlier] = await Promise.all([
      db.section.findMany({
        where: { id: { in: sectionIds } },
        select: { id: true, classGradeId: true },
      }),
      db.enrollment.findMany({
        where: {
          studentId: { in: placements.map((p) => p.studentId) },
          academicYearId: { in: placements.map((p) => p.academicYearId) },
        },
        select: {
          studentId: true,
          sectionId: true,
          academicYearId: true,
          section: { select: { classGradeId: true } },
        },
      }),
    ]);
    const classOf = new Map(sections.map((s) => [s.id, s.classGradeId]));
    const restarting = placements.filter((p) =>
      earlier.some(
        (e) =>
          e.studentId === p.studentId &&
          e.academicYearId === p.academicYearId &&
          e.sectionId !== p.sectionId &&
          e.section.classGradeId === classOf.get(p.sectionId),
      ),
    );
    if (restarting.length) {
      await db.studentSubject.deleteMany({
        where: {
          OR: restarting.map((p) => ({
            studentId: p.studentId,
            academicYearId: p.academicYearId,
            sectionSubject: {
              section: { classGradeId: classOf.get(p.sectionId) },
            },
          })),
        },
      });
      for (const p of restarting) fresh.add(keyOf(p));
    }
  }
  const offerings = await db.sectionSubject.findMany({
    where: {
      sectionId: { in: [...new Set(placements.map((p) => p.sectionId))] },
      isElective: true,
      ...(onlySectionSubjectIds && { id: { in: onlySectionSubjectIds } }),
    },
    select: {
      id: true,
      sectionId: true,
      subjectId: true,
      section: { select: { schoolId: true, classGradeId: true } },
    },
  });
  if (!offerings.length) return;

  // A subject is taken from one section only: never tick a student into it here
  // while they take the same subject from a sibling section.
  const takenFrom = new Map<string, Set<string>>();
  const subjectKey = (
    studentId: string,
    academicYearId: string,
    classGradeId: string,
    subjectId: string,
  ) => `${studentId}:${academicYearId}:${classGradeId}:${subjectId}`;
  for (const r of await db.studentSubject.findMany({
    where: {
      studentId: { in: placements.map((p) => p.studentId) },
      academicYearId: { in: placements.map((p) => p.academicYearId) },
      sectionSubject: { subjectId: { in: offerings.map((o) => o.subjectId) } },
    },
    select: {
      studentId: true,
      academicYearId: true,
      sectionSubject: {
        select: {
          sectionId: true,
          subjectId: true,
          section: { select: { classGradeId: true } },
        },
      },
    },
  })) {
    const key = subjectKey(
      r.studentId,
      r.academicYearId,
      r.sectionSubject.section.classGradeId,
      r.sectionSubject.subjectId,
    );
    takenFrom.set(
      key,
      (takenFrom.get(key) ?? new Set()).add(r.sectionSubject.sectionId),
    );
  }
  const pickedFromSibling = (
    p: { studentId: string; academicYearId: string },
    o: (typeof offerings)[number],
  ) =>
    [
      ...(takenFrom.get(
        subjectKey(
          p.studentId,
          p.academicYearId,
          o.section.classGradeId,
          o.subjectId,
        ),
      ) ?? []),
    ].some((sectionId) => sectionId !== o.sectionId);

  const sectionOf = new Map(offerings.map((o) => [o.id, o.sectionId]));
  const held = onlySectionSubjectIds
    ? new Set<string>()
    : new Set(
        (
          await db.studentSubject.findMany({
            where: {
              studentId: { in: placements.map((p) => p.studentId) },
              sectionSubjectId: { in: offerings.map((o) => o.id) },
            },
            select: {
              studentId: true,
              sectionSubjectId: true,
              academicYearId: true,
            },
          })
        ).map(
          (r) =>
            `${r.studentId}:${sectionOf.get(r.sectionSubjectId)}:${r.academicYearId}`,
        ),
      );
  await db.studentSubject.createMany({
    data: placements
      .filter((p) => fresh.has(keyOf(p)) || !held.has(keyOf(p)))
      .flatMap((p) =>
        offerings
          .filter(
            (o) => o.sectionId === p.sectionId && !pickedFromSibling(p, o),
          )
          .map((o) => ({
            schoolId: o.section.schoolId,
            academicYearId: p.academicYearId,
            studentId: p.studentId,
            sectionSubjectId: o.id,
          })),
      ),
    skipDuplicates: true,
  });
}

/**
 * Clears one placement's selections — every pick in that session from any
 * section of the class, since they were all made against the placement the
 * student is leaving.
 */
export async function clearSelections(
  db: Db,
  placement: { studentId: string; sectionId: string; academicYearId: string },
): Promise<void> {
  await db.studentSubject.deleteMany({
    where: {
      studentId: placement.studentId,
      academicYearId: placement.academicYearId,
      sectionSubject: {
        section: {
          classGrade: { sections: { some: { id: placement.sectionId } } },
        },
      },
    },
  });
}
