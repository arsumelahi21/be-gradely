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
} from 'class-validator';
import { DayOfWeek } from '../../../common/types/timetable.type';
import { MINUTES_IN_DAY } from '../timetable-time';

export class UpsertConfigDto {
  // SUPER_ADMIN must pass the target school explicitly (BaseSchoolScopedService).
  @IsOptional()
  @IsUUID()
  schoolId?: string;

  @IsOptional()
  @IsString()
  timezone?: string; // IANA name; validated against Intl in the service

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

  @IsInt()
  @Min(1)
  @Max(600)
  periodMinutes: number;
}
