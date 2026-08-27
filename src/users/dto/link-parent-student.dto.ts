import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { GuardianRelationship } from '../../common/types/student.type';

export class LinkParentStudentDto {
  @IsString()
  @IsUUID()
  parentProfileId: string;

  @IsString()
  @IsUUID()
  studentProfileId: string;

  @IsOptional()
  @IsEnum(GuardianRelationship)
  relationship?: GuardianRelationship;
}
