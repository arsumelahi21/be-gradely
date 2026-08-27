import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ReportPreset } from '../fees.types';

/** Shared filters across every report endpoint, so a filtered view is a URL. */
export class FeeReportQueryDto {
  @IsOptional()
  @IsUUID()
  schoolId?: string;

  @IsOptional()
  @IsUUID()
  academicYearId?: string;

  @IsOptional()
  @IsUUID()
  classGradeId?: string;

  @IsOptional()
  @IsUUID()
  sectionId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  periodYear?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  periodMonth?: number;

  /** Months of history for the collection trend. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(36)
  months?: number;

  /** Row cap for the outstanding table. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  /**
   * Rolling window preset. Resolved SERVER-side so every report agrees on the
   * boundaries and the response can echo them back for display. Ignored when
   * an explicit `from`/`to` is supplied — a custom range always wins.
   */
  @IsOptional()
  @IsEnum(ReportPreset)
  preset?: ReportPreset;

  /** Custom range, inclusive, filtering on the challan's `issueDate`. */
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
