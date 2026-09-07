import { IsISO8601, IsOptional, ValidateIf } from 'class-validator';

/**
 * The window a timetable applies to. Both fields are nullable: clearing them
 * means "the whole academic year", which is the default a timetable starts with.
 * Dates only — a timetable changes on a day boundary, never mid-morning.
 */
export class UpdateTimetableWindowDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsISO8601({ strict: true })
  effectiveFrom?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsISO8601({ strict: true })
  effectiveTo?: string | null;
}
