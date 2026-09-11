import { IsOptional, IsUUID } from 'class-validator';

/**
 * Who is ALREADY sitting in a destination class, in the session being promoted
 * into.
 *
 * Occupancy is a property of (section, academic year) — the same section holds
 * a different roster each session — so the year is required, not optional.
 */
export class FindDestinationQueryDto {
  /** The session being promoted INTO. */
  @IsUUID()
  academicYearId: string;

  @IsUUID()
  classGradeId: string;

  /** SUPER_ADMIN only — a SCHOOL_ADMIN is pinned to their own school. */
  @IsOptional()
  @IsUUID()
  schoolId?: string;
}
