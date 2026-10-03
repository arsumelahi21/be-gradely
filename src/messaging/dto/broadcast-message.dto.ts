import {
  ArrayMaxSize,
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
  // Each recipient is a separate thread and send; this bounds one request's work.
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  recipientUserIds!: string[];

  @IsString()
  @MaxLength(5000)
  body!: string;
}
