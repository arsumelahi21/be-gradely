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
// The period DTOs use the module's own enum, matching create/update-period-slot.
import { PeriodKind } from '../../../common/types/timetable.type';

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

  /**
   * The period's type, when the draft changed it. Carried here because the grid
   * edits period type locally and only flushes on publish — without this the
   * change would be silently dropped. Turning a period into a break while a
   * lecture still sits on it is caught by the existing "not a class period"
   * check, which reads the POST-retime kind.
   */
  @IsOptional()
  @IsEnum(PeriodKind)
  kind?: PeriodKind;
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
