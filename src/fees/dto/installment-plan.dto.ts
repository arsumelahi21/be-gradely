import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_INSTALLMENTS } from '../fee-calculator';

export class InstallmentRowDto {
  /**
   * Minor units. Unlike `monthlyFeeAmount` — where 0 is deliberately valid — a
   * zero installment is meaningless: a student who owes nothing has no plan.
   */
  @Type(() => Number)
  @IsInt({ message: 'Each installment needs an amount' })
  @Min(1, { message: 'An installment amount must be at least 1' })
  amount: number;

  @IsDateString({}, { message: 'Each installment needs a valid due date' })
  dueDate: string;
}

/**
 * Full replacement of a student's plan — create and edit are the same call, so
 * a double-submitted admission form upserts instead of creating a second plan.
 *
 * A schedule is edited as a whole, so there are no per-row endpoints: `seq` is
 * assigned from array order and stays contiguous with no renumbering logic.
 *
 * The only inputs are the year's total, a start date and the rows themselves.
 * There is deliberately no cadence field: the dates are generated in the UI and
 * then owned by each row, so the stored schedule is exactly what was agreed.
 */
export class SetInstallmentPlanDto {
  @IsUUID(undefined, { message: 'An installment plan needs an academic year' })
  academicYearId: string;

  /** The student's full academic-year fee. The installments must sum to it. */
  @Type(() => Number)
  @IsInt({ message: 'The plan total is required' })
  @Min(1, { message: 'The plan total must be at least 1' })
  totalAmount: number;

  @IsDateString({}, { message: 'The plan needs a valid start date' })
  startDate: string;

  /** False switches the plan off without discarding the schedule. */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsArray()
  @ArrayMinSize(1, { message: 'A plan needs at least one installment' })
  @ArrayMaxSize(MAX_INSTALLMENTS, {
    message: `A plan cannot exceed ${MAX_INSTALLMENTS} installments`,
  })
  @ValidateNested({ each: true })
  @Type(() => InstallmentRowDto)
  installments: InstallmentRowDto[];
}
