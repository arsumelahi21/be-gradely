import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { PeriodKind } from '../../../common/types/timetable.type';
import { MINUTES_IN_DAY } from '../timetable-time';

// All fields optional — a partial edit of one stored slot. `index` is deliberately
// NOT editable here (it aligns with recorded Attendance.period; see the plan §26).
export class UpdatePeriodSlotDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MINUTES_IN_DAY)
  startMin?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MINUTES_IN_DAY)
  endMin?: number;

  @IsOptional()
  @IsEnum(PeriodKind)
  kind?: PeriodKind;
}
