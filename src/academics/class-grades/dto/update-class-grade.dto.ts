import { PartialType } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateClassGradeDto } from './create-class-grade.dto';

export class UpdateClassGradeDto extends PartialType(CreateClassGradeDto) {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
