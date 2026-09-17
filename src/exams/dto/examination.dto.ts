import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ExaminationResultStatus, ExaminationStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { CreateExamSubjectDto } from './exam-subject.dto';

export class CreateExaminationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @IsUUID()
  academicYearId!: string;

  @IsUUID()
  classGradeId!: string;

  @IsUUID()
  sectionId!: string;

  @IsOptional()
  @IsUUID()
  termId?: string | null;

  @IsOptional()
  @IsUUID()
  gradingSchemeId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  instructions?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => CreateExamSubjectDto)
  subjects?: CreateExamSubjectDto[];
}

export class UpdateExaminationDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsUUID()
  academicYearId?: string;

  @IsOptional()
  @IsUUID()
  classGradeId?: string;

  @IsOptional()
  @IsUUID()
  sectionId?: string;

  @IsOptional()
  @IsUUID()
  termId?: string | null;

  @IsOptional()
  @IsUUID()
  gradingSchemeId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  instructions?: string | null;
}

export class ReviewReasonDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason!: string;
}

export class ListExaminationsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @IsUUID()
  schoolId?: string;

  @IsOptional()
  @IsUUID()
  academicYearId?: string;

  @IsOptional()
  @IsUUID()
  classGradeId?: string;

  @IsOptional()
  @IsUUID()
  sectionId?: string;

  @IsOptional()
  @IsUUID()
  termId?: string;

  @IsOptional()
  @IsUUID()
  teacherId?: string;

  @IsOptional()
  @IsUUID()
  studentId?: string;

  @IsOptional()
  @IsEnum(ExaminationStatus)
  status?: ExaminationStatus;

  @IsOptional()
  @IsEnum(ExaminationResultStatus)
  resultStatus?: ExaminationResultStatus;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  /** "approvals" limits the list to proposals that have been sent for review at least once. */
  @IsOptional()
  @IsIn(['approvals'])
  view?: 'approvals';
}

export class StudentQueryDto {
  @IsOptional()
  @IsUUID()
  studentId?: string;
}
