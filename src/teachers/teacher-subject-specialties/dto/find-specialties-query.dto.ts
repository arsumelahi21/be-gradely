import { IsOptional, IsUUID } from 'class-validator';

export class FindSpecialtiesQueryDto {
  @IsOptional()
  @IsUUID()
  teacherId?: string;

  @IsOptional()
  @IsUUID()
  subjectId?: string;

  @IsOptional()
  @IsUUID()
  schoolId?: string;
}
