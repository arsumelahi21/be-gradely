import { PartialType } from '@nestjs/swagger';
import { CreateTeacherSubjectSpecialtyDto } from './create-teacher-subject-specialty.dto';

export class UpdateTeacherSubjectSpecialtyDto extends PartialType(
  CreateTeacherSubjectSpecialtyDto,
) {}
