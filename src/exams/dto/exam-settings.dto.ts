import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

// A cleared date input arrives as "", which @IsOptional doesn't skip; store it as no date.
const blankToNull = ({ value }: { value: unknown }) =>
  value === '' ? null : value;

export class ListTermsQueryDto {
  @IsOptional()
  @IsUUID()
  academicYearId?: string;
}

export class CreateTermDto {
  @IsUUID()
  academicYearId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  sortOrder?: number;

  @Transform(blankToNull)
  @IsOptional()
  @IsDateString()
  startDate?: string | null;

  @Transform(blankToNull)
  @IsOptional()
  @IsDateString()
  endDate?: string | null;
}

export class UpdateTermDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  sortOrder?: number;

  @Transform(blankToNull)
  @IsOptional()
  @IsDateString()
  startDate?: string | null;

  @Transform(blankToNull)
  @IsOptional()
  @IsDateString()
  endDate?: string | null;
}

export class GradeBandDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  label!: string;

  @IsInt()
  @Min(0)
  @Max(100)
  minPercent!: number;

  @IsBoolean()
  isPassing!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  remark?: string | null;
}

export class CreateGradingSchemeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => GradeBandDto)
  bands!: GradeBandDto[];
}

export class UpdateGradingSchemeDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => GradeBandDto)
  bands?: GradeBandDto[];
}
