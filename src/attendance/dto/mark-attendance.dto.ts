import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { AttendanceStatus } from '../../common/types/attendance.type';

export class MarkAttendanceEntryDto {
  @IsUUID()
  studentId: string;

  @IsEnum(AttendanceStatus)
  status: AttendanceStatus;

  @IsOptional()
  @IsString()
  remarks?: string;
}

export class MarkAttendanceDto {
  @IsUUID()
  sectionSubjectId: string;

  @IsDateString()
  date: string;

  // 1 = the single / first period of that subject that day. Defaults to 1.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  period?: number;

  // SUPER_ADMIN must pass the target school explicitly (BaseSchoolScopedService).
  @IsOptional()
  @IsString()
  schoolId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MarkAttendanceEntryDto)
  entries: MarkAttendanceEntryDto[];
}
