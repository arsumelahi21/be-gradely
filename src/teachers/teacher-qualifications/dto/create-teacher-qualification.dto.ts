import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class CreateTeacherQualificationDto {
  @IsUUID()
  teacherId: string;

  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  institution?: string;

  @IsOptional()
  @IsInt()
  @Min(1900)
  @Max(3000)
  completionYear?: number;

  @IsOptional()
  @IsString()
  description?: string;
}
