import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaymentMethod, PaymentSubmissionStatus } from '../fees.types';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

/**
 * Payment proof from a student or parent. Multipart, so every scalar arrives as
 * a string — `@Type(() => Number)` is what makes `amount` an Int.
 *
 * The receipt itself is NOT in this DTO: the file comes through the interceptor
 * and its S3 key is written server-side, so a client can never point a
 * submission at an arbitrary object.
 */
export class CreatePaymentSubmissionDto {
  /** Minor units. Claimed, not credited — validated against the live balance. */
  @Type(() => Number)
  @IsInt({ message: 'Amount is required' })
  @Min(1, { message: 'Amount must be at least 1' })
  amount: number;

  @IsEnum(PaymentMethod, { message: 'Choose a valid payment method' })
  method: PaymentMethod;

  @IsDateString({}, { message: 'A valid payment date is required' })
  paidAt: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /** Which installment the submitter is paying toward — a snapshot of intent. */
  @IsOptional()
  @IsUUID()
  installmentId?: string;
}

/** Rejection reason is optional, matching the existing voidPayment flow. */
export class RejectPaymentSubmissionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class PaymentSubmissionQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(PaymentSubmissionStatus)
  status?: PaymentSubmissionStatus;

  @IsOptional()
  @IsUUID()
  studentId?: string;

  /**
   * Narrow to when the proof was SUBMITTED — the queue's own timeline, not the
   * challan's billing period (one month's post can settle several periods, and
   * each row already shows its challan's month).
   *
   * `year` alone is a whole year; `month` without a year is ignored, since a
   * month has no meaning on its own.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  year?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;

  @IsOptional()
  @IsUUID()
  schoolId?: string;
}
