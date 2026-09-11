import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * One transaction's worth of students. A class rarely passes 60 and a whole
 * class-grade a few hundred; this bounds the write so one request cannot hold a
 * transaction open over thousands of rows.
 */
export const MAX_PROMOTION_BATCH = 500;

export class PromotionStudentDto {
  @IsUUID()
  studentId: string;

  @IsUUID()
  destinationClassGradeId: string;

  /** An existing section. Takes precedence over `destinationSectionName`. */
  @IsOptional()
  @IsUUID()
  destinationSectionId?: string;

  /** Resolved by name against the destination class; created only if `createMissingSections`. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  destinationSectionName?: string;
}

/** Shared by preview and execute, so the summary an admin confirms is re-decided from the same shape. */
export class PromotionPlanDto {
  @IsUUID()
  sourceAcademicYearId: string;

  @IsUUID()
  targetAcademicYearId: string;

  /** Off by default: creating a section is a side effect an admin opts into. */
  @IsOptional()
  @IsBoolean()
  createMissingSections?: boolean;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_PROMOTION_BATCH)
  @ValidateNested({ each: true })
  @Type(() => PromotionStudentDto)
  students: PromotionStudentDto[];

  /** SUPER_ADMIN only — a SCHOOL_ADMIN is pinned to their own school. */
  @IsOptional()
  @IsUUID()
  schoolId?: string;
}
