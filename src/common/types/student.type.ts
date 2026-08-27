// Mirrors the Prisma `Gender`/`GuardianRelationship` enums. Local TS enums (like role.type.ts) so
// DTOs/services validate without depending on the generated Prisma client.

export enum Gender {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  OTHER = 'OTHER',
  PREFER_NOT_TO_SAY = 'PREFER_NOT_TO_SAY',
}

export enum GuardianRelationship {
  MOTHER = 'MOTHER',
  FATHER = 'FATHER',
  GUARDIAN = 'GUARDIAN',
  OTHER = 'OTHER',
}
