import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { DayOfWeek } from '../../../common/types/timetable.type';

// Edit a CLASS assignment. Moving the cell (day/period) is allowed; subject and
// teacher can be re-picked. `room`/`note` accept explicit null to clear.
export class UpdateEntryDto {
  @IsOptional()
  @IsEnum(DayOfWeek)
  dayOfWeek?: DayOfWeek;

  @IsOptional()
  @IsUUID()
  periodId?: string;

  @IsOptional()
  @IsUUID()
  sectionSubjectId?: string;

  @IsOptional()
  @IsUUID()
  teacherId?: string;

  @IsOptional()
  @ValidateIf((o) => o.room !== null)
  @IsString()
  @MaxLength(120)
  room?: string | null;

  @IsOptional()
  @ValidateIf((o) => o.note !== null)
  @IsString()
  @MaxLength(200)
  note?: string | null;
}
