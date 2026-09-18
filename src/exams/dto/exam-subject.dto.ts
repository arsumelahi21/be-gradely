import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

// null clears a field; @IsOptional lets null through without running the validators.
export class ExamSubjectFieldsDto {
  @IsOptional()
  @IsDateString()
  heldAt?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1439)
  startMin?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  endMin?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  venue?: string | null;

  @IsOptional()
  @IsUUID()
  invigilatorTeacherId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxScore?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  passingMarks?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}

export class CreateExamSubjectDto extends ExamSubjectFieldsDto {
  @IsUUID()
  sectionSubjectId!: string;
}

export class UpdateExamSubjectDto extends ExamSubjectFieldsDto {}

export class ReplaceExamSubjectsDto {
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => CreateExamSubjectDto)
  subjects!: CreateExamSubjectDto[];
}
