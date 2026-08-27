import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { DiscountType } from '../fees.types';

export class CreateDiscountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsEnum(DiscountType)
  type: DiscountType;

  // PERCENT: whole percent. FIXED: minor units. The PERCENT<=100 bound is
  // type-dependent, so the service enforces it (@ValidateIf would gate every
  // validator on this property, not just the max).
  @Type(() => Number)
  @IsInt()
  @Min(0)
  value: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsUUID()
  schoolId?: string;
}
