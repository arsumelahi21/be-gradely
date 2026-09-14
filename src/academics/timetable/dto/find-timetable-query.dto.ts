import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class FindTimetableQueryDto {
  // SUPER_ADMIN scopes reads/writes to a school with this; SCHOOL_ADMIN is pinned to their own.
  @IsOptional()
  @IsUUID()
  schoolId?: string;

  // Optional academic-year filter; defaults to the school's active year in the service.
  @IsOptional()
  @IsUUID()
  academicYearId?: string;
}

// PARENT "my child's timetable" needs to pick which child.
export class MyTimetableQueryDto extends FindTimetableQueryDto {
  @IsOptional()
  @IsUUID()
  studentId?: string;
}

/**
 * Deleting a PUBLISHED timetable requires `?force=true` — it is live for
 * students. Declared here because the route also binds `@Query()` to a DTO, and
 * the global forbidNonWhitelisted pipe validates the WHOLE query string against
 * it: an undeclared `force` is a 400 before the handler ever runs.
 *
 * Kept as the raw string the query carries; the controller compares it.
 */
export class DeleteTimetableQueryDto extends FindTimetableQueryDto {
  @IsOptional()
  @IsIn(['true', 'false'])
  force?: string;
}
