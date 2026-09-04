import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { DayOfWeek, PeriodKind } from '../../../common/types/timetable.type';
import { MINUTES_IN_DAY } from '../timetable-time';

export class BreakSpecDto {
  @IsInt()
  @Min(0)
  @Max(MINUTES_IN_DAY)
  startMin: number;

  @IsInt()
  @Min(1)
  @Max(MINUTES_IN_DAY)
  durationMin: number;

  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsEnum(PeriodKind)
  kind?: PeriodKind; // only BREAK/LUNCH/ASSEMBLY are meaningful here
}

/**
 * The per-section setup screen: create the section's timetable and generate its
 * bell schedule. `periodCount` (if given) divides the day into that many class
 * periods; otherwise `periodMinutes` sets the duration. SUPER passes `schoolId`.
 */
export class SetupTimetableDto {
  @IsOptional()
  @IsUUID()
  schoolId?: string;

  @IsOptional()
  @IsUUID()
  academicYearId?: string;

  @IsArray()
  @ArrayUnique()
  @IsEnum(DayOfWeek, { each: true })
  workingDays: DayOfWeek[];

  @IsInt()
  @Min(0)
  @Max(MINUTES_IN_DAY)
  dayStartMin: number;

  @IsInt()
  @Min(0)
  @Max(MINUTES_IN_DAY)
  dayEndMin: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  periodCount?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  periodMinutes?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BreakSpecDto)
  breaks?: BreakSpecDto[];
}
