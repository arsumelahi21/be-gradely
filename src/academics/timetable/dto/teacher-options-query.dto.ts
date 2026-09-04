import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { DayOfWeek } from '../../../common/types/timetable.type';

/** Candidate slot to evaluate qualified teachers against (UX support for the picker). */
export class TeacherOptionsQueryDto {
  @IsUUID()
  sectionSubjectId: string;

  @IsEnum(DayOfWeek)
  dayOfWeek: DayOfWeek;

  @IsUUID()
  periodId: string;

  // Exclude the entry being edited so it doesn't conflict with itself.
  @IsOptional()
  @IsUUID()
  excludeEntryId?: string;
}
