import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsOptional,
  IsUUID,
} from 'class-validator';

/** Matches the promotion run ceiling — a run is bounded by a class, not a school. */
export const MAX_BULK_STUDENTS = 500;
const MAX_BULK_SUBJECTS = 50;

/**
 * A delta, not a replacement set: two admins editing the same section can't
 * silently undo each other, and the payload is the size of the change.
 */
export class UpdateStudentSubjectsDto {
  @IsUUID()
  academicYearId: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_BULK_STUDENTS)
  @IsUUID(undefined, { each: true })
  studentIds: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_BULK_SUBJECTS)
  @IsUUID(undefined, { each: true })
  add?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_BULK_SUBJECTS)
  @IsUUID(undefined, { each: true })
  remove?: string[];
}
