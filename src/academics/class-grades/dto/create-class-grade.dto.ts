import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { CLASS_LEVEL_VALUES } from '../../../common/types/class-level.type';

export class CreateClassGradeDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  description?: string;

  /**
   * Minor units. Pre-fills the admission form's fee for every section of this
   * class; the student's own `monthlyFeeAmount` remains what is billed.
   * Send `null` to clear it — 0 is a real (free) default, not "unset".
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Default monthly fee must be a whole number' })
  @Min(0, { message: 'Default monthly fee cannot be negative' })
  defaultMonthlyFee?: number | null;

  /**
   * Rung on the ladder — PG/Nursery/Prep then 1..10. Drives the order classes
   * and their sections appear in everywhere. Optional so an existing class
   * without one still saves; it just sorts last.
   */
  @IsOptional()
  @Type(() => Number)
  @IsIn(CLASS_LEVEL_VALUES, { message: 'Pick a class level from the list' })
  level?: number | null;

  @IsOptional()
  @IsUUID()
  schoolId?: string;
}
