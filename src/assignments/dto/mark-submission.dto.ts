import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class MarkSubmissionDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  score?: number;

  @IsOptional()
  @IsString()
  remarks?: string;
}
