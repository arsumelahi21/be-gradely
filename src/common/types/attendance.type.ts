// Mirrors the Prisma `AttendanceStatus` enum. Local TS enum (like role.type.ts) so DTOs validate
// without depending on the generated client.
export enum AttendanceStatus {
  PRESENT = 'PRESENT',
  ABSENT = 'ABSENT',
  LATE = 'LATE',
  EXCUSED = 'EXCUSED',
}
