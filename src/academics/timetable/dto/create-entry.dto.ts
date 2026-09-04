import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { DayOfWeek } from '../../../common/types/timetable.type';

/**
 * A CLASS-cell assignment: subject (SectionSubject, the attendance anchor) +
 * an independently chosen qualified teacher. The target period must be a
 * CLASS-kind period (validated in the service).
 */
export class CreateEntryDto {
  @IsEnum(DayOfWeek)
  dayOfWeek: DayOfWeek;

  @IsUUID()
  periodId: string;

  @IsUUID()
  sectionSubjectId: string;

  /** Optional: defaults to the teacher allocated to this subject for the class. */
  @IsOptional()
  @IsUUID()
  teacherId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  room?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
