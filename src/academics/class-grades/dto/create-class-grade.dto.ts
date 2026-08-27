import { IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateClassGradeDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsUUID()
  schoolId?: string;
}
