import { PartialType } from '@nestjs/swagger';
import { CreateTeacherQualificationDto } from './create-teacher-qualification.dto';

export class UpdateTeacherQualificationDto extends PartialType(
  CreateTeacherQualificationDto,
) {}
