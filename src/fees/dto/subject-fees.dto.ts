import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class SubjectFeeItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  code: string;

  /** Minor units. 0 is a free subject; null removes the fee. */
  @ValidateIf((o: SubjectFeeItemDto) => o.amount !== null)
  @IsInt()
  @Min(0, { message: 'A subject fee cannot be negative' })
  amount: number | null;
}

export class SetSubjectFeesDto {
  /** Required for SUPER_ADMIN; a SCHOOL_ADMIN is pinned to their own school. */
  @IsOptional()
  @IsUUID()
  schoolId?: string;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => SubjectFeeItemDto)
  items: SubjectFeeItemDto[];
}
