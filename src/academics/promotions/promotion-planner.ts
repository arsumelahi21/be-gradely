/**
 * Promotion decision engine — PURE. No Prisma, no I/O, no clock.
 *
 * Everything that decides *what should happen to a student* lives here, so it
 * unit-tests without a database (same shape as `fee-calculator.ts` and
 * `quiz-import.parser.ts`). `promotions.service.ts` only loads state, calls
 * this, and writes the result.
 *
 * This is also the seam for advanced promotion rules (pass/fail, minimum
 * attendance, fee clearance): they become extra inputs and extra `outcome`
 * values, with no change to the transaction below them.
 */

/** What the plan decided for one student. First match wins, in this order. */
export type PromotionOutcome =
  /** Create a new enrollment in the destination. */
  | 'PROMOTE'
  /** A non-ACTIVE row already sits in the exact destination — flip it back to ACTIVE instead of duplicating it. */
  | 'REACTIVATE'
  /** Already holds an ACTIVE class in the target session. The duplicate-promotion guard. */
  | 'ALREADY_PROMOTED'
  /** Destination equals where they already are (same session, same section). Nothing to do. */
  | 'SAME_PLACEMENT'
  /** No ACTIVE enrollment in the source scope — a stale selection. */
  | 'NOT_ENROLLED'
  /** No destination section could be resolved. The only outcome that blocks the whole run. */
  | 'NO_DESTINATION';

/** The one outcome an execute call refuses to proceed on. */
export const BLOCKING_OUTCOMES: readonly PromotionOutcome[] = [
  'NO_DESTINATION',
];

export interface PromotionRequest {
  studentId: string;
  destinationClassGradeId: string;
  /** An existing section, chosen explicitly. Wins over `destinationSectionName`. */
  destinationSectionId?: string | null;
  /** Resolved against existing sections by name; may be created when missing. */
  destinationSectionName?: string | null;
}

export interface SourceEnrollment {
  enrollmentId: string;
  sectionId: string;
  label: string;
}

export interface TargetEnrollment {
  enrollmentId: string;
  studentId: string;
  sectionId: string;
  isActive: boolean;
  label: string;
}

export interface DestinationSection {
  id: string;
  name: string;
  classGradeId: string;
  label: string;
}

export interface PromotionPlanInput {
  sourceAcademicYearId: string;
  targetAcademicYearId: string;
  requests: PromotionRequest[];
  /** ACTIVE source-session enrollments, by studentId. */
  sourceEnrollments: Map<string, SourceEnrollment>;
  /** EVERY row these students hold in the target session, any status. */
  targetEnrollments: TargetEnrollment[];
  /** Existing sections of the destination classes, keyed by `sectionKey()`. */
  existingSections: Map<string, DestinationSection>;
  studentNames: Map<string, string>;
  /** Class names for the destination classes, by id — used to build labels. */
  classNames: Map<string, string>;
  /** When false, a destination section that doesn't exist blocks instead of being created. */
  createMissingSections: boolean;
}

export interface PromotionPlanItem {
  studentId: string;
  fullName: string;
  outcome: PromotionOutcome;
  /** Why, in words an admin can act on. Always set for non-PROMOTE outcomes. */
  reason?: string;
  fromLabel: string | null;
  toLabel: string | null;
  sourceEnrollmentId: string | null;
  /** The section being left. Lets the caller find sections a run empties. */
  sourceSectionId: string | null;
  /** Null when the destination section still has to be created. */
  destinationSectionId: string | null;
  /** Links a PROMOTE item to its entry in `sectionsToCreate`. */
  destinationSectionKey: string | null;
  /** Set only for REACTIVATE. */
  reactivateEnrollmentId: string | null;
}

export interface SectionToCreate {
  key: string;
  classGradeId: string;
  name: string;
  label: string;
}

export interface PromotionPlan {
  items: PromotionPlanItem[];
  sectionsToCreate: SectionToCreate[];
  counts: Record<PromotionOutcome, number>;
  /** True when nothing blocks; execute refuses otherwise. */
  canExecute: boolean;
}

/** Sections are unique per `[classGradeId, name]`, so that pair is the key. Case-insensitive: "A" and "a" are one section to an admin. */
export function sectionKey(classGradeId: string, name: string): string {
  return `${classGradeId}::${name.trim().toLowerCase()}`;
}

/** "Grade 6 A" — what an admin calls a placement. */
export function placementLabel(className: string, sectionName: string): string {
  return `${className} ${sectionName}`.trim();
}

/**
 * The numeric rung of a class name: "Grade 5" → 5, "CLASS-10" → 10, "5" → 5.
 * Null for names with no digits ("Nursery"), which simply get no suggestion.
 */
export function parseClassLevel(name: string): number | null {
  const match = /\d+/.exec(name);
  if (!match) return null;
  const level = Number.parseInt(match[0], 10);
  return Number.isSafeInteger(level) ? level : null;
}

/**
 * The name with its digits and separators stripped: "Grade 5" → "grade".
 * Distinguishes ladders that share numbers — "KG-2" must not suggest "Grade 3".
 */
export function classNamePrefix(name: string): string {
  return name
    .toLowerCase()
    .replace(/\d+/g, ' ')
    .replace(/[^a-z]+/g, ' ')
    .trim();
}

/**
 * The next class up: same prefix and one rung higher, e.g. 5 → 6.
 * Falls back to any class at level+1 when no prefix matches, and returns null
 * when the current class has no number. A suggestion only — the admin overrides.
 */
export function suggestNextClass<T extends { id: string; name: string }>(
  current: { id: string; name: string },
  classes: T[],
): T | null {
  const level = parseClassLevel(current.name);
  if (level === null) return null;

  const prefix = classNamePrefix(current.name);
  const candidates = classes.filter(
    (c) => c.id !== current.id && parseClassLevel(c.name) === level + 1,
  );
  if (!candidates.length) return null;

  const sameLadder = candidates.filter(
    (c) => classNamePrefix(c.name) === prefix,
  );
  const pool = sameLadder.length ? sameLadder : candidates;
  return [...pool].sort((a, b) => a.name.localeCompare(b.name))[0];
}

/**
 * The matching section in the next class — same name, so 5-A → 6-A.
 * Identity today; it exists as a named step so a future rule (balance sizes,
 * merge sections) has one place to change.
 */
export function suggestSectionName(sourceSectionName: string): string {
  return sourceSectionName;
}

const EMPTY_COUNTS = (): Record<PromotionOutcome, number> => ({
  PROMOTE: 0,
  REACTIVATE: 0,
  ALREADY_PROMOTED: 0,
  SAME_PLACEMENT: 0,
  NOT_ENROLLED: 0,
  NO_DESTINATION: 0,
});

/**
 * Classify every requested student. Called by BOTH preview and execute against
 * freshly-loaded state, so what the admin confirmed is what the write re-decides.
 */
export function buildPromotionPlan(input: PromotionPlanInput): PromotionPlan {
  const sameSession = input.sourceAcademicYearId === input.targetAcademicYearId;

  const targetByStudent = new Map<string, TargetEnrollment[]>();
  for (const row of input.targetEnrollments) {
    const list = targetByStudent.get(row.studentId);
    if (list) list.push(row);
    else targetByStudent.set(row.studentId, [row]);
  }

  // Indexed once: an explicit section id is otherwise a scan per student.
  const sectionsById = new Map<string, DestinationSection>();
  for (const section of input.existingSections.values()) {
    sectionsById.set(section.id, section);
  }

  const items: PromotionPlanItem[] = [];
  const sectionsToCreate = new Map<string, SectionToCreate>();
  const counts = EMPTY_COUNTS();

  // One item per request, de-duplicated: a student listed twice must not be
  // promoted twice, and the second row would hit the enrollment unique key.
  const seen = new Set<string>();

  for (const request of input.requests) {
    if (seen.has(request.studentId)) continue;
    seen.add(request.studentId);

    const fullName = input.studentNames.get(request.studentId) ?? 'Student';
    const source = input.sourceEnrollments.get(request.studentId);
    // `sourceSectionId` is filled here rather than at each call site — every
    // item leaves the same section, and one place cannot forget it.
    const push = (
      item: Omit<
        PromotionPlanItem,
        'studentId' | 'fullName' | 'sourceSectionId'
      >,
    ) => {
      items.push({
        studentId: request.studentId,
        fullName,
        sourceSectionId: source?.sectionId ?? null,
        ...item,
      });
      counts[item.outcome] += 1;
    };

    if (!source) {
      push({
        outcome: 'NOT_ENROLLED',
        reason: `${fullName} no longer holds an active place in the selected class.`,
        fromLabel: null,
        toLabel: null,
        sourceEnrollmentId: null,
        destinationSectionId: null,
        destinationSectionKey: null,
        reactivateEnrollmentId: null,
      });
      continue;
    }

    const className =
      input.classNames.get(request.destinationClassGradeId) ?? '';

    // Destination: an explicit section id wins; otherwise resolve by name and,
    // if it doesn't exist, queue it for creation when that was allowed.
    let destinationSectionId: string | null = null;
    let destinationSectionKey: string | null = null;
    let toLabel: string | null = null;

    if (request.destinationSectionId) {
      const existing = sectionsById.get(request.destinationSectionId);
      // The section must belong to the class named in the same request —
      // otherwise the summary would promise a class the write wouldn't deliver.
      if (
        existing &&
        existing.classGradeId === request.destinationClassGradeId
      ) {
        destinationSectionId = existing.id;
        toLabel = existing.label;
      }
    } else if (request.destinationSectionName?.trim()) {
      const name = request.destinationSectionName.trim();
      const key = sectionKey(request.destinationClassGradeId, name);
      const existing = input.existingSections.get(key);
      if (existing) {
        // Reuse — never a duplicate section.
        destinationSectionId = existing.id;
        toLabel = existing.label;
      } else if (input.createMissingSections) {
        destinationSectionKey = key;
        toLabel = placementLabel(className, name);
        if (!sectionsToCreate.has(key)) {
          sectionsToCreate.set(key, {
            key,
            classGradeId: request.destinationClassGradeId,
            name,
            label: toLabel,
          });
        }
      } else {
        push({
          outcome: 'NO_DESTINATION',
          reason: `Section "${placementLabel(className, name)}" does not exist. Turn on "create missing sections", or pick an existing one.`,
          fromLabel: source.label,
          toLabel: null,
          sourceEnrollmentId: source.enrollmentId,
          destinationSectionId: null,
          destinationSectionKey: null,
          reactivateEnrollmentId: null,
        });
        continue;
      }
    }

    if (!destinationSectionId && !destinationSectionKey) {
      push({
        outcome: 'NO_DESTINATION',
        reason: `No destination section chosen for ${fullName}.`,
        fromLabel: source.label,
        toLabel: null,
        sourceEnrollmentId: source.enrollmentId,
        destinationSectionId: null,
        destinationSectionKey: null,
        reactivateEnrollmentId: null,
      });
      continue;
    }

    // Moving a student onto the place they already occupy.
    if (sameSession && destinationSectionId === source.sectionId) {
      push({
        outcome: 'SAME_PLACEMENT',
        reason: `${fullName} is already in ${source.label}.`,
        fromLabel: source.label,
        toLabel,
        sourceEnrollmentId: source.enrollmentId,
        destinationSectionId,
        destinationSectionKey: null,
        reactivateEnrollmentId: null,
      });
      continue;
    }

    // Within one session the source row IS a target-session row; excluding it
    // is what stops a same-session move reporting itself as already promoted.
    const held = (targetByStudent.get(request.studentId) ?? []).filter(
      (row) => row.enrollmentId !== source.enrollmentId,
    );

    const active = held.find((row) => row.isActive);
    if (active) {
      push({
        outcome: 'ALREADY_PROMOTED',
        reason: `${fullName} already holds ${active.label} in the destination session.`,
        fromLabel: source.label,
        toLabel,
        sourceEnrollmentId: source.enrollmentId,
        destinationSectionId,
        destinationSectionKey: null,
        reactivateEnrollmentId: null,
      });
      continue;
    }

    // A past row in the exact destination — reactivate it, because
    // [studentId, sectionId, academicYearId] is unique and a second insert would fail.
    const dormant = destinationSectionId
      ? held.find((row) => row.sectionId === destinationSectionId)
      : undefined;
    if (dormant) {
      push({
        outcome: 'REACTIVATE',
        reason: `${fullName} held this place before — the existing record is reactivated rather than duplicated.`,
        fromLabel: source.label,
        toLabel,
        sourceEnrollmentId: source.enrollmentId,
        destinationSectionId,
        destinationSectionKey: null,
        reactivateEnrollmentId: dormant.enrollmentId,
      });
      continue;
    }

    push({
      outcome: 'PROMOTE',
      fromLabel: source.label,
      toLabel,
      sourceEnrollmentId: source.enrollmentId,
      destinationSectionId,
      destinationSectionKey,
      reactivateEnrollmentId: null,
    });
  }

  // Only keep sections that a surviving PROMOTE item still needs.
  const neededKeys = new Set(
    items
      .filter((i) => i.outcome === 'PROMOTE' && i.destinationSectionKey)
      .map((i) => i.destinationSectionKey as string),
  );

  return {
    items,
    sectionsToCreate: [...sectionsToCreate.values()].filter((s) =>
      neededKeys.has(s.key),
    ),
    counts,
    canExecute: !items.some((i) => BLOCKING_OUTCOMES.includes(i.outcome)),
  };
}
