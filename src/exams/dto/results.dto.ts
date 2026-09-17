import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class MarkEntryDto {
  @IsUUID()
  studentId!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  score?: number | null;

  @IsOptional()
  @IsBoolean()
  isAbsent?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remarks?: string | null;
}

export class SaveMarksDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => MarkEntryDto)
  entries!: MarkEntryDto[];

  // Date sheets publish without marks, so the totals are set here, before the first score.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxScore?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  passingMarks?: number | null;
}

export class RemarkEntryDto {
  @IsUUID()
  studentId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  classTeacherRemarks?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  principalRemarks?: string | null;
}

export class SaveRemarksDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => RemarkEntryDto)
  entries!: RemarkEntryDto[];
}

export class ResultCardQueryDto {
  @IsOptional()
  @IsUUID()
  academicYearId?: string;

  @IsOptional()
  @IsUUID()
  termId?: string;
}
