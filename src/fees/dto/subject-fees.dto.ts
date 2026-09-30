import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class SubjectFeeItemDto {
  // No length cap: Subject.code has none, and a code this DTO rejects would
  // leave its class blocked from billing with no way out in the product.
  @IsString()
  @Matches(/\S/, { message: 'A subject code cannot be blank' })
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
