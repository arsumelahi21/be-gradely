import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { EnrollmentStatus } from '@prisma/client';

export class FindEnrollmentsQueryDto {
  @IsOptional()
  @IsUUID()
  schoolId?: string;

  @IsOptional()
  @IsUUID()
  studentId?: string;

  @IsOptional()
  @IsUUID()
  sectionId?: string;

  @IsOptional()
  @IsUUID()
  academicYearId?: string;

  /**
   * Defaults to ACTIVE — the current roster.
   *
   * Promotion closes the old placement as COMPLETED rather than deleting it, so
   * an unfiltered read shows a student in the class they have already left.
   * Ask for a status explicitly to read that history.
   */
  @IsOptional()
  @IsEnum(EnrollmentStatus)
  status?: EnrollmentStatus;
}
