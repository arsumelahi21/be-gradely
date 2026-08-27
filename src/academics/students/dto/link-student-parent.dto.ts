import { IsUUID } from 'class-validator';

export class LinkStudentParentDto {
  @IsUUID()
  parentProfileId: string;
}
