import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class GlobalSearchQueryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  q!: string;

  /** SUPER_ADMIN must pass the school to search; SCHOOL_ADMIN is pinned to theirs. */
  @IsOptional()
  @IsUUID()
  schoolId?: string;
}
