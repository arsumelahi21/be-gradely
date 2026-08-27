import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { PaymentMethod } from '../fees.types';

export class RecordPaymentDto {
  /** Minor units. Min(1) rejects zero and negative amounts outright. */
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'Payment amount must be greater than zero' })
  amount: number;

  @IsEnum(PaymentMethod)
  method: PaymentMethod;

  /** Cheque no, bank reference, transaction id… */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  /** Defaults to now when omitted (back-dating a cash receipt is allowed). */
  @IsOptional()
  @IsDateString()
  paidAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** A correction is a void, never an edit or a delete. */
export class VoidPaymentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CancelChallanDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
