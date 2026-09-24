import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class FindStudentSubjectsQueryDto extends PaginationQueryDto {
  @IsUUID()
  sectionId: string;

  @IsUUID()
  academicYearId: string;

  /** Matches student name or roll number. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}
