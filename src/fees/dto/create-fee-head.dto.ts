import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateFeeHeadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  /** Minor units. 0 is valid — a head can be a placeholder until priced. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  defaultAmount: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsUUID()
  schoolId?: string;
}
