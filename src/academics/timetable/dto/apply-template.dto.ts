import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { DayOfWeek } from '../../../common/types/timetable.type';

export class TemplateAssignmentDto {
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
}

/**
 * The single-day template the principal configured. On save it is replicated to
 * EVERY working day of the section's timetable (Mon–Fri by default), replacing
 * any existing entries. `templateDay` is informational only.
 */
export class ApplyTemplateDto {
  @IsOptional()
  @IsEnum(DayOfWeek)
  templateDay?: DayOfWeek;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateAssignmentDto)
  assignments: TemplateAssignmentDto[];
}
