import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { DayOfWeek } from '@prisma/client';

/** One retimed period in the draft (existing period, referenced by id). */
export class PublishPeriodDto {
  @IsString()
  id!: string;

  @IsInt()
  @Min(0)
  startMin!: number;

  @IsInt()
  @Min(0)
  endMin!: number;

  @IsOptional()
  @IsString()
  label?: string;
}

/** One lecture in the draft grid. */
export class PublishEntryDto {
  @IsEnum(DayOfWeek)
  dayOfWeek!: DayOfWeek;

  @IsString()
  periodId!: string;

  @IsString()
  sectionSubjectId!: string;

  @IsString()
  teacherId!: string;

  @IsOptional()
  @IsString()
  room?: string | null;
}

/**
 * Batch-publish payload: the FULL desired timetable. When `entries` is present
 * the server reconciles the whole grid in one transaction; an empty body keeps
 * the legacy "just flip status to PUBLISHED" behaviour for already-saved rows.
 */
export class PublishTimetableDto {
  @IsOptional()
  @IsString()
  academicYearId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PublishPeriodDto)
  periods?: PublishPeriodDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PublishEntryDto)
  entries?: PublishEntryDto[];
}
