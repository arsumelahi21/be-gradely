import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ThreadType } from '@prisma/client';

export class CreateThreadDto {
  @IsEnum(ThreadType)
  type!: ThreadType;

  /** DIRECT: the other user to open a 1:1 thread with. */
  @ValidateIf((o) => o.type === ThreadType.DIRECT)
  @IsUUID()
  recipientUserId?: string;

  /** CLASS: the section whose roster becomes the participants. */
  @ValidateIf((o) => o.type === ThreadType.CLASS)
  @IsUUID()
  sectionId?: string;

  /** GROUP: the hand-picked participants (besides the creator). */
  @ValidateIf((o) => o.type === ThreadType.GROUP)
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID(undefined, { each: true })
  participantIds?: string[];

  /** GROUP: optional group name (falls back to participant names client-side). */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;
}
