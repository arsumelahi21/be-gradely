import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

// Multipart, so every field arrives as a string — `@Type(() => Number)` is what
// turns durationMins into an int before `@IsInt` sees it.
export class ImportQuizDto {
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
  @Type(() => Number)
  @IsInt()
  @Min(1)
  durationMins?: number;
}
