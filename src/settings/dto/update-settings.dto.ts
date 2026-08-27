import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';

export class UpdateSettingsDto {
  @IsOptional()
  @IsBoolean()
  emailNotifications?: boolean;

  @IsOptional()
  @IsBoolean()
  inAppNotifications?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyAnnouncements?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyMessages?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyGrades?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyAttendance?: boolean;

  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsIn(['light', 'dark', 'system'])
  theme?: string;
}
