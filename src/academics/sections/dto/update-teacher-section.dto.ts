import { PartialType } from '@nestjs/swagger';
import { LinkTeacherSectionDto } from './link-teacher-section.dto';

export class UpdateTeacherSectionDto extends PartialType(
  LinkTeacherSectionDto,
) {}
