import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** Report a user to the school's admins (super-admin if the reporter is an admin). */
export class ReportUserDto {
  @IsUUID()
  reportedUserId!: string;

  @IsString()
  @MaxLength(1000)
  reason!: string;

  /** Optional thread the report relates to (for context). */
  @IsOptional()
  @IsUUID()
  threadId?: string;
}
