import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { Role } from '../../common/types/role.type';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class FindUsersQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @IsOptional()
  @IsString()
  search?: string;

  /** Students only: narrows to those with an ACTIVE enrollment in this class. */
  @IsOptional()
  @IsUUID()
  classGradeId?: string;

  /** Students only: narrows to those with an ACTIVE enrollment in this section. */
  @IsOptional()
  @IsUUID()
  sectionId?: string;

  /**
   * Students only: keep ONLY those holding no ACTIVE placement in
   * `unassignedAcademicYearId` — the "not in any class yet" picker.
   *
   * Scoped to one session on purpose. Judging it across all time would hide
   * every student who has ever been enrolled, so nobody could be placed after
   * their first year.
   */
  @IsOptional()
  @IsUUID()
  unassignedAcademicYearId?: string;
}
