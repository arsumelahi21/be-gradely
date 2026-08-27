import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { ChallanGenerationType } from '../fees.types';
import { MAX_INSTALLMENTS } from '../fee-calculator';

/** Bulk generation for one section + one billing month. Also used for preview. */
export class GenerateChallansDto {
  @IsUUID()
  academicYearId: string;

  /**
   * One section, or omit it and pass `classGradeId` to bill every section of a
   * class in one run. Exactly one of the two is required — enforced in the
   * service, where the "which sections" question is actually answered.
   */
  @IsOptional()
  @IsUUID()
  sectionId?: string;

  /** Every active section of this class. Ignored when `sectionId` is given. */
  @IsOptional()
  @IsUUID()
  classGradeId?: string;

  /**
   * Defaults to NORMAL so every existing caller keeps its exact behaviour.
   * INSTALLMENT bills one scheduled row instead, and deliberately skips the
   * normal challan for those students.
   */
  @IsOptional()
  @IsEnum(ChallanGenerationType)
  generationType?: ChallanGenerationType;

  /**
   * Which row of the plan to bill. Required for INSTALLMENT — without it there
   * is no way to know which installment is meant, and guessing would be worse
   * than refusing.
   */
  @ValidateIf(
    (o: GenerateChallansDto) =>
      o.generationType === ChallanGenerationType.INSTALLMENT,
  )
  @Type(() => Number)
  @IsInt({ message: 'Choose which installment to generate' })
  @Min(1)
  @Max(MAX_INSTALLMENTS)
  installmentSeq?: number;

  /** The billing period. For INSTALLMENT it is derived from the due date. */
  @ValidateIf(
    (o: GenerateChallansDto) =>
      o.generationType !== ChallanGenerationType.INSTALLMENT,
  )
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  periodYear: number;

  @ValidateIf(
    (o: GenerateChallansDto) =>
      o.generationType !== ChallanGenerationType.INSTALLMENT,
  )
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  periodMonth: number;

  /** Defaults to the school's default account when omitted. */
  @IsOptional()
  @IsUUID()
  bankAccountId?: string;

  /** Overrides the date derived from School.feeDueDayOfMonth. */
  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsDateString()
  issueDate?: string;

  @IsOptional()
  @IsUUID()
  schoolId?: string;
}
