import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateGroupDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  /** Every group has exactly one director, chosen when it is created. */
  @IsUUID()
  directorId: string;
}

export class UpdateGroupDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsUUID()
  directorId?: string;
}

export class ListGroupsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  search?: string;
}

export class AttachSchoolDto {
  @IsUUID()
  schoolId: string;
}

// No schoolId or role field: the whitelist pipe rejects both, so a director can never be
// created with a school.
export class CreateDirectorDto {
  @IsEmail()
  email: string;

  // Same rule as CreateUserDto: the Super Admin chooses it and hands it over.
  @IsString()
  @MinLength(8)
  password: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fullName: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  phoneDialCode?: string;
}

export class UpdateDirectorDto {
  /** Their sign-in; changing it keeps the password. */
  @IsOptional()
  @Transform(trim)
  @IsEmail()
  email?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  fullName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  phoneDialCode?: string;
}

export class ListDirectorsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
