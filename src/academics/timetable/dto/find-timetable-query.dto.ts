import { IsOptional, IsUUID } from 'class-validator';

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
