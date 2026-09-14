import { IsOptional, IsUUID } from 'class-validator';

/** The source scope of a promotion run: who is being considered, and for which target session. */
export class FindPromotionStudentsQueryDto {
  /** Session the students currently sit in. */
  @IsUUID()
  academicYearId: string;

  @IsUUID()
  classGradeId: string;

  /** Omit to take every section of the class. */
  @IsOptional()
  @IsUUID()
  sectionId?: string;

  /** When given, each student is flagged with any place they already hold in it. */
  @IsOptional()
  @IsUUID()
  targetAcademicYearId?: string;

  /** SUPER_ADMIN only — a SCHOOL_ADMIN is pinned to their own school. */
  @IsOptional()
  @IsUUID()
  schoolId?: string;
}
