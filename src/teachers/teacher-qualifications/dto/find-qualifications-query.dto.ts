import { IsOptional, IsUUID } from 'class-validator';

export class FindQualificationsQueryDto {
  @IsOptional()
  @IsUUID()
  teacherId?: string;

  @IsOptional()
  @IsUUID()
  schoolId?: string;
}
