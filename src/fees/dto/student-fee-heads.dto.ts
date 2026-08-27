import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class StudentFeeHeadOverrideDto {
  @IsUUID()
  feeHeadId: string;

  /** Minor units. 0 is valid — the head is charged, at nothing. */
  @Type(() => Number)
  @IsInt()
  @Min(0, { message: 'A fee head amount cannot be negative' })
  amount: number;

  /** True = this head isn't charged to this student at all. */
  @IsOptional()
  @IsBoolean()
  isExcluded?: boolean;
}

/**
 * Full replacement of one student's overrides. Sending the complete set (rather
 * than patching one head) keeps "reset to school default" expressible: a head
 * simply absent from the list has no override.
 */
export class SetStudentFeeHeadsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => StudentFeeHeadOverrideDto)
  overrides: StudentFeeHeadOverrideDto[];
}
