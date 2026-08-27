import { IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';

export class CreateExamDto {
  @IsUUID()
  academicYearId: string;

  @IsUUID()
  sectionSubjectId: string;

  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  heldAt?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxScore?: number;
}
