import { IsOptional, IsUUID } from 'class-validator';

export class FindSectionsQueryDto {
  @IsOptional()
  @IsUUID()
  schoolId?: string;

  @IsOptional()
  @IsUUID()
  classGradeId?: string;
}
