import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** The five fee columns on School — there is no FeeSettings model. */
export class UpdateFeeSettingsDto {
  @IsOptional()
  @IsString()
  @Length(3, 3, { message: 'Currency must be a 3-letter ISO 4217 code' })
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  feeChallanPrefix?: string;

  // Capped at 28 so every month — February included — actually has the day.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(28)
  feeDueDayOfMonth?: number;

  @IsOptional()
  @IsBoolean()
  installmentReminderEnabled?: boolean;

  // 0 = remind on the due date itself; 60 is a season's notice, well past useful.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60)
  installmentReminderDaysBefore?: number;

  // SUPER_ADMIN must name the school; SCHOOL_ADMIN is pinned to their own.
  @IsOptional()
  @IsUUID()
  schoolId?: string;
}
