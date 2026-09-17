/**
 * The only teacher fields a student or parent may see on a nested payload.
 *
 * `TeacherProfile` carries phone, email, address, designation and emergency contacts,
 * so `teacher: true` on any include that reaches a student ships all of it. Backend
 * code reads only `fullName`/`userId` off these relations, and the frontend types ask
 * for `{id, userId}` (assignments) and `{id, userId, fullName?}` (exams).
 */
export const TEACHER_PUBLIC = {
  select: { id: true, fullName: true, userId: true },
} as const;
