import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { ChallanStatus } from '../fees.types';

/** Filters shared by the challan list; every one is a shareable query param. */
export class ChallanQueryDto extends PaginationQueryDto {
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
  studentId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  periodYear?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  periodMonth?: number;

  @IsOptional()
  @IsEnum(ChallanStatus)
  status?: ChallanStatus;

  /** Derived, not stored — filters on dueDate + unsettled status. */
  @IsOptional()
  @IsString()
  overdue?: string;

  /** Matches challan number, student name, or roll number. */
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

/** Per-class Created / Not Created grid for one billing month. */
export class ChallanCoverageQueryDto {
  @IsOptional()
  @IsUUID()
  schoolId?: string;

  @IsUUID()
  academicYearId: string;

  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  periodYear: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  periodMonth: number;
}

/** Which installment rows a section can be billed for, and which already are. */
export class SectionInstallmentQueryDto {
  @IsOptional()
  @IsUUID()
  schoolId?: string;

  @IsUUID()
  academicYearId: string;

  @IsUUID()
  sectionId: string;
}

/** Batch fee status for the student-list badge — one request per page. */
export class StudentFeeStatusDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  studentIds: string[];

  @IsOptional()
  @IsUUID()
  schoolId?: string;
}
