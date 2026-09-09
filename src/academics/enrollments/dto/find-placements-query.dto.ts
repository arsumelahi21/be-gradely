import { IsOptional, IsUUID } from 'class-validator';

/** Query for the enrol picker's "who already has a class this year" lookup. */
export class FindPlacementsQueryDto {
  /** Required: placements are only meaningful within one academic year. */
  @IsUUID()
  academicYearId: string;

  /** SUPER_ADMIN only — a SCHOOL_ADMIN is pinned to their own school. */
  @IsOptional()
  @IsUUID()
  schoolId?: string;
}
