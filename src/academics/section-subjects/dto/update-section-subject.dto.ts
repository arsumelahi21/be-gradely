import { PartialType } from '@nestjs/swagger';
import { CreateSectionSubjectDto } from './create-section-subject.dto';

export class UpdateSectionSubjectDto extends PartialType(
  CreateSectionSubjectDto,
) {}
