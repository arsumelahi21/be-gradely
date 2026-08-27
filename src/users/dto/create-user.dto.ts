import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Role } from '../../common/types/role.type';
import { Gender, GuardianRelationship } from '../../common/types/student.type';

/**
 * Parent created inline during student registration (when the guardian isn't
 * already in the list); becomes a real linked PARENT account.
 */
export class NewParentDto {
  @IsString()
  fullName: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  phone: string;

  @IsOptional()
  @IsString()
  phoneDialCode?: string;

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

  // Extra profile info (all optional).
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

  // Personal email distinct from the login email (falls back to login email).
  @IsOptional()
  @IsEmail()
  personalEmail?: string;
}

// Role-conditional "required" helper: field is required when role matches
// (e.g. STUDENT for city), else optional but still type-checked if supplied.
const requiredForStudent = (field: keyof CreateUserDto) => (o: CreateUserDto) =>
  o.role === Role.STUDENT || o[field] !== undefined;
const requiredForTeacherOrParent =
  (field: keyof CreateUserDto) => (o: CreateUserDto) =>
    o.role === Role.TEACHER || o.role === Role.PARENT || o[field] !== undefined;

export class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsEnum(Role)
  role: Role;

  // required for all except SUPER_ADMIN
  @IsOptional()
  @IsString()
  schoolId?: string;

  // mandatory "profile" field
  @IsString()
  fullName: string;

  // Required for TEACHER/PARENT (their main contact number); optional but
  // still type-checked for other roles.
  @ValidateIf(requiredForTeacherOrParent('phone'))
  @IsString()
  phone?: string;

  // Dial code paired with `phone` (e.g. "+1"), chosen from a dropdown on the
  // frontend to keep phone data consistent.
  @IsOptional()
  @IsString()
  phoneDialCode?: string;

  @IsOptional()
  @IsEmail()
  profileEmail?: string;

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

  @ValidateIf(requiredForStudent('city'))
  @IsString()
  city?: string;

  @ValidateIf(requiredForStudent('state'))
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  postalCode?: string;

  @ValidateIf(requiredForStudent('country'))
  @IsString()
  country?: string;

  // Guardian is now derived from a linked parent (see parentProfileId / newParent
  // below); these stay optional here for backward compatibility.
  @IsOptional()
  @IsString()
  guardianName?: string;

  @IsOptional()
  @IsString()
  guardianPhone?: string;

  // Guardian link for a new STUDENT: exactly one of parentProfileId (existing)
  // or newParent (create+link); required on create, enforced in the service.
  @IsOptional()
  @IsUUID()
  parentProfileId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => NewParentDto)
  newParent?: NewParentDto;

  @IsOptional()
  @IsEnum(GuardianRelationship)
  relationship?: GuardianRelationship;

  @IsOptional()
  @IsString()
  emergencyContactName?: string;

  @IsOptional()
  @IsString()
  emergencyContactPhone?: string;

  // Per-school user id for teacher/parent/school-admin. Omitted auto-generates a
  // role-prefixed code (e.g. TCH-0001); supplied is a manual override. Not used for students (see rollNo).
  @IsOptional()
  @IsString()
  userCode?: string;

  // Student-specific fields
  @IsOptional()
  @IsString()
  rollNo?: string;

  // If omitted, the server auto-generates a per-school admission number.
  // If provided, the given value is used (manual override).
  @IsOptional()
  @IsString()
  admissionNo?: string;

  @ValidateIf(requiredForStudent('dob'))
  @IsDateString()
  dob?: string;

  @ValidateIf(requiredForStudent('dateOfJoining'))
  @IsDateString()
  dateOfJoining?: string;

  @ValidateIf(requiredForStudent('gender'))
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

  // National identity number (CNIC for adults, B-Form for a student).
  @IsOptional()
  @IsString()
  nationalId?: string;

  // Personal email distinct from the login email (falls back to login email).
  @IsOptional()
  @IsEmail()
  personalEmail?: string;

  // Parent-only info (ignored for other roles).
  @IsOptional()
  @IsString()
  occupation?: string;

  @IsOptional()
  @IsString()
  academicStatus?: string;

  // Student-only: previous institute + entry-test marks.
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

  // ---- Fee configuration (student-only; mandatory at admission) ----
  // Deliberately NOT @IsOptional(): that skips validation for null AND
  // undefined, which would admit a student with no fee. 0 is a valid amount and
  // passes @IsInt, so absence — not zero — is what fails here.
  @ValidateIf(requiredForStudent('monthlyFeeAmount'))
  @Type(() => Number)
  @IsInt({ message: 'Monthly fee is required' })
  @Min(0, { message: 'Monthly fee cannot be negative' })
  monthlyFeeAmount?: number;

  @IsOptional()
  @IsUUID()
  discountId?: string;
}
