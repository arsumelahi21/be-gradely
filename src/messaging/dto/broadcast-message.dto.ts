import {
  ArrayNotEmpty,
  IsArray,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * "Send individually": same message delivered to each recipient as a separate
 * 1:1 DIRECT thread (not a group). Text-only — no attachments for fan-out sends.
 */
export class BroadcastMessageDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID(undefined, { each: true })
  recipientUserIds!: string[];

  @IsString()
  @MaxLength(5000)
  body!: string;
}
