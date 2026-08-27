import { PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { CreateSectionDto } from './create-section.dto';

export class UpdateSectionDto extends PartialType(CreateSectionDto) {
  @IsOptional()
  @IsUUID()
  classGradeId?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
