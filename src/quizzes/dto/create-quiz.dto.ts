import { Type } from 'class-transformer';
import {
  IsArray,
  IsDefined,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { QuestionType } from '../../common/types/quiz.type';

export class QuizOptionDto {
  @IsString()
  @IsNotEmpty()
  id: string;

  @IsString()
  @IsNotEmpty()
  text: string;
}

export class CreateQuestionInput {
  @IsEnum(QuestionType)
  type: QuestionType;

  @IsString()
  @IsNotEmpty()
  text: string;

  // MULTIPLE_CHOICE only: the selectable options.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuizOptionDto)
  options?: QuizOptionDto[];

  // MCQ: the correct option id (string). TRUE_FALSE: boolean.
  // Shape is validated in the service against `type`.
  @IsDefined()
  correctAnswer: string | boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  points?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;
}

export class CreateQuizDto {
  @IsUUID()
  sectionId: string;

  @IsOptional()
  @IsUUID()
  subjectId?: string;

  @IsString()
  @IsNotEmpty()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  durationMins?: number;

  // Optionally create the quiz together with its questions (one transaction).
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateQuestionInput)
  questions?: CreateQuestionInput[];
}
