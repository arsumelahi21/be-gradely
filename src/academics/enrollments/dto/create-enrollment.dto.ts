import { EnrollmentStatus } from '@prisma/client';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsUUID,
} from 'class-validator';

export class CreateEnrollmentDto {
  @IsUUID()
  studentId: string;

  @IsUUID()
  sectionId: string;

  @IsUUID()
  academicYearId: string;

  @IsOptional()
  @IsEnum(EnrollmentStatus)
  status?: EnrollmentStatus;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  /** Omitted = every student-selection subject, the default all other callers rely on. */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty({ message: 'Choose at least one subject for the student' })
  @ArrayUnique({ message: 'Each subject can only be chosen once' })
  @ArrayMaxSize(50)
  @IsUUID(undefined, { each: true })
  sectionSubjectIds?: string[];
}
