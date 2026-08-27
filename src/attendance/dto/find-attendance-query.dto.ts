import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** Roster + status for one subject-period on a date. */
export class SectionSubjectAttendanceQueryDto {
  @IsDateString()
  date: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  period?: number;

  @IsOptional()
  @IsString()
  schoolId?: string;
}

/** A student's per-period history in a date range, paginated. */
export class StudentAttendanceQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;

  @IsOptional()
  @IsString()
  schoolId?: string;
}

/** Aggregates for dashboard widgets. */
export class StudentAttendanceStatsQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsString()
  schoolId?: string;
}

/** Per-student attendance percentages across a subject-class's roster. */
export class SectionSubjectSummaryQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsString()
  schoolId?: string;
}

/** Schoolwide attendance rate (admin/principal dashboard). */
export class SchoolAttendanceStatsQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  // SUPER_ADMIN must pass one; SCHOOL_ADMIN is pinned to their own.
  @IsOptional()
  @IsString()
  schoolId?: string;
}

/** A teacher's per-subject-class attendance rate (teacher dashboard). */
export class TeacherAttendanceStatsQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
