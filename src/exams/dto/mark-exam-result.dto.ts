import { IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class MarkExamResultDto {
  @IsUUID()
  studentId: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  score?: number;

  @IsOptional()
  @IsString()
  grade?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  rank?: number;

  @IsOptional()
  @IsString()
  remarks?: string;
}
