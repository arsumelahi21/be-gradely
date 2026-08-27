import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';

export class CreateSectionSubjectDto {
  @IsUUID()
  sectionId: string;

  @IsUUID()
  subjectId: string;

  @IsOptional()
  @ValidateIf(
    (o) =>
      o.teacherId !== null && o.teacherId !== undefined && o.teacherId !== '',
  )
  @IsUUID()
  teacherId?: string | null;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsString()
  schedule?: string;
}
