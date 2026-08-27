import { PartialType } from '@nestjs/mapped-types';
import { CreateExamDto } from './create-exam.dto';
import { IsOptional, IsString } from 'class-validator';

export class UpdateExamDto extends PartialType(CreateExamDto) {
  @IsOptional()
  @IsString()
  status?: 'DRAFT' | 'PUBLISHED' | 'CLOSED';
}
