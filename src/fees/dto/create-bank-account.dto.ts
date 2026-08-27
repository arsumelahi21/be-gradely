import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateBankAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  bankName: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  accountTitle: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  accountNumber: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  iban?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  branch?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Setting this clears the flag on the school's other accounts. */
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsUUID()
  schoolId?: string;
}
