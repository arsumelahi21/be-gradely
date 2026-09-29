-- Every subject becomes student-selectable — "Compulsory" is gone from Section Setup.
--
-- A selectable subject counts only the students ticked for it, so each compulsory
-- subject is first ticked for every student ever placed in its section, in that
-- placement's own session (current, withdrawn and past). Nobody loses a subject,
-- and past sessions' exams and report cards keep their students. Choices already
-- made on selectable subjects are left alone.
--
-- Locked so an enrolment or a new subject cannot land between the ticks and the
-- flip, which would leave that student without the subject.
LOCK TABLE "Enrollment", "SectionSubject" IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO "StudentSubject"
  ("id", "schoolId", "academicYearId", "studentId", "sectionSubjectId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t."schoolId", t."academicYearId", t."studentId", t."sectionSubjectId", now(), now()
FROM (
  SELECT DISTINCT sec."schoolId", e."academicYearId", e."studentId", ss."id" AS "sectionSubjectId"
  FROM "SectionSubject" ss
  JOIN "Section" sec ON sec."id" = ss."sectionId"
  JOIN "Enrollment" e ON e."sectionId" = ss."sectionId"
  WHERE ss."isElective" = false
) t
ON CONFLICT ("studentId", "sectionSubjectId", "academicYearId") DO NOTHING;

UPDATE "SectionSubject" SET "isElective" = true, "updatedAt" = now() WHERE "isElective" = false;
