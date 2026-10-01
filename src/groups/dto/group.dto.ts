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

export class GroupNameDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;
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
