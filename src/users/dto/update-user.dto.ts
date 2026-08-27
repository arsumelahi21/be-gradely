import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Gender } from '../../common/types/student.type';

export class UpdateUserDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  phoneDialCode?: string;

  @IsOptional()
  @IsString()
  phoneSecondary?: string;

  @IsOptional()
  @IsString()
  alternatePhone?: string;

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
  @IsEmail()
  profileEmail?: string;

  @IsOptional()
  @IsString()
  schoolId?: string;

  // Per-school user id for teacher/parent/school-admin (manual override).
  @IsOptional()
  @IsString()
  userCode?: string;

  // Student-specific fields
  @IsOptional()
  @IsString()
  rollNo?: string;

  @IsOptional()
  @IsDateString()
  dob?: string;

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
  @IsString()
  admissionNo?: string;

  @IsOptional()
  @IsDateString()
  dateOfJoining?: string;

  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @IsOptional()
  @IsString()
  bloodGroup?: string;

  // ---- Extra optional profile info (student + parent) ----
  @IsOptional()
  @IsString()
  whatsapp?: string;

  @IsOptional()
  @IsString()
  whatsappDialCode?: string;

  @IsOptional()
  @IsString()
  nationalId?: string;

  @IsOptional()
  @IsString()
  occupation?: string;

  @IsOptional()
  @IsString()
  academicStatus?: string;

  @IsOptional()
  @IsString()
  prevInstituteName?: string;

  @IsOptional()
  @IsString()
  prevAdmissionNo?: string;

  @IsOptional()
  @IsString()
  prevLeavingReason?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  entryTestObtainedMarks?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  entryTestTotalMarks?: number;

  // ---- Fee configuration ----
  // Optional on update so edits of legacy records aren't blocked; the service
  // uses `!== undefined` so an explicit 0 still writes.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0, { message: 'Monthly fee cannot be negative' })
  monthlyFeeAmount?: number;

  // Nullable on purpose — sending null clears the student's discount.
  @IsOptional()
  @IsUUID()
  discountId?: string | null;
}
