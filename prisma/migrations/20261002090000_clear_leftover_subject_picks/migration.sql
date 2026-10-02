-- Clears subject picks left behind by a closed placement.
--
-- A student's picks in a class and session belong to their open placement. Until
-- now, withdrawing from section X and joining sibling Y (same class, same session)
-- left X's rows in place, and the all-subjects backfill ticked closed placements
-- too — so readers took X's subjects for current picks from a sibling section.
--
-- Deleted: a row on section X's subject where the student's placement in X that
-- session is closed, while they hold a placement in a sibling section Y of the same
-- class that session which is ACTIVE (or COMPLETED, when X was only INACTIVE).
-- Kept: every placement's rows on its own section; genuine sibling picks (no
-- placement in X at all); sessions with no open placement in the class, so past
-- report cards are untouched. Attendance and marks are never touched.
--
-- Idempotent. Locked so an enrolment can't land between the check and the delete.
LOCK TABLE "Enrollment", "StudentSubject" IN SHARE ROW EXCLUSIVE MODE;

DELETE FROM "StudentSubject" s
USING "SectionSubject" o, "Section" xs, "Enrollment" x
WHERE o.id = s."sectionSubjectId"
  AND xs.id = o."sectionId"
  AND x."studentId" = s."studentId"
  AND x."sectionId" = o."sectionId"
  AND x."academicYearId" = s."academicYearId"
  AND x.status <> 'ACTIVE'
  AND EXISTS (
    SELECT 1 FROM "Enrollment" y
    JOIN "Section" ys ON ys.id = y."sectionId"
    WHERE y."studentId" = s."studentId"
      AND y."academicYearId" = s."academicYearId"
      AND y."sectionId" <> o."sectionId"
      AND ys."classGradeId" = xs."classGradeId"
      AND (y.status = 'ACTIVE' OR (y.status = 'COMPLETED' AND x.status = 'INACTIVE'))
  );
