import { IsString, IsUUID, IsOptional } from 'class-validator';

export class CreateSectionDto {
  @IsUUID()
  classGradeId: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  room?: string;
}
