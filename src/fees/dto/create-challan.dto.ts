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

/** Single-student challan. Runs the same path as bulk with a roster of one. */
export class CreateChallanDto {
  /** StudentProfile id (not User id). */
  @IsUUID()
  studentId: string;

  @IsUUID()
  academicYearId: string;

  /** Omitted = NORMAL, so the existing single-student dialog is unchanged. */
  @IsOptional()
  @IsEnum(ChallanGenerationType)
  generationType?: ChallanGenerationType;

  /** Which plan row to bill. Required for INSTALLMENT. */
  @ValidateIf(
    (o: CreateChallanDto) =>
      o.generationType === ChallanGenerationType.INSTALLMENT,
  )
  @Type(() => Number)
  @IsInt({ message: 'Choose which installment to generate' })
  @Min(1)
  @Max(MAX_INSTALLMENTS)
  installmentSeq?: number;

  /** The billing period. For INSTALLMENT it is derived from the due date. */
  @ValidateIf(
    (o: CreateChallanDto) =>
      o.generationType !== ChallanGenerationType.INSTALLMENT,
  )
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  periodYear: number;

  @ValidateIf(
    (o: CreateChallanDto) =>
      o.generationType !== ChallanGenerationType.INSTALLMENT,
  )
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  periodMonth: number;

  @IsOptional()
  @IsUUID()
  bankAccountId?: string;

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
