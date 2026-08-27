import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class CreateStudentDto {
  @IsString()
  fullName: string;

  @IsString()
  admissionNo: string;

  @IsOptional()
  @IsString()
  rollNo?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  alternatePhone?: string;

  @IsOptional()
  @IsDateString()
  dob?: string;

  @IsOptional()
  @IsDateString()
  dateOfJoining?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  addressLine1?: string;

  @IsOptional()
  @IsString()
  addressLine2?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  postalCode?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  guardianName?: string;

  @IsOptional()
  @IsString()
  guardianPhone?: string;

  @IsOptional()
  @IsString()
  emergencyContactName?: string;

  @IsOptional()
  @IsString()
  emergencyContactPhone?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsUUID()
  schoolId?: string;

  // ---- Fee configuration (mandatory at admission) ----
  // Same rule as CreateUserDto: no @IsOptional(), because it skips null AND
  // undefined. A fee of 0 is valid; a missing fee is not. Enforced on BOTH
  // student-creation paths so neither can bypass the other.
  @Type(() => Number)
  @IsInt({ message: 'Monthly fee is required' })
  @Min(0, { message: 'Monthly fee cannot be negative' })
  monthlyFeeAmount: number;

  @IsOptional()
  @IsUUID()
  discountId?: string;
}
