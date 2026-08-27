// Mirrors the Prisma `QuestionType` / `QuizAttemptStatus` enums.
// Beta scope: objective question types only (auto-scorable).
export enum QuestionType {
  MULTIPLE_CHOICE = 'MULTIPLE_CHOICE',
  TRUE_FALSE = 'TRUE_FALSE',
}

export enum QuizAttemptStatus {
  IN_PROGRESS = 'IN_PROGRESS',
  SUBMITTED = 'SUBMITTED',
  GRADED = 'GRADED',
}
