import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { PeriodKind } from '../../../common/types/timetable.type';
import { MINUTES_IN_DAY } from '../timetable-time';

// Add ONE period to a section's bell schedule. schoolId/timetable are derived
// from the section (per-section periods now). Validated against the whole set.
export class CreatePeriodSlotDto {
  @IsInt()
  @Min(1)
  @Max(50)
  index: number;

  @IsOptional()
  @IsString()
  label?: string;

  @IsInt()
  @Min(0)
  @Max(MINUTES_IN_DAY)
  startMin: number;

  @IsInt()
  @Min(0)
  @Max(MINUTES_IN_DAY)
  endMin: number;

  @IsOptional()
  @IsEnum(PeriodKind)
  kind?: PeriodKind;
}
