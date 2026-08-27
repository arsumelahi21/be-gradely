import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * A file already uploaded to S3 via presign; server re-validates MIME/size
 * against the allow-list before persisting (never trust client-supplied values).
 */
export class AttachmentRefDto {
  @IsString()
  @MaxLength(1024)
  s3Key!: string;

  @IsString()
  @MaxLength(255)
  fileName!: string;

  @IsString()
  @MaxLength(255)
  mimeType!: string;

  @IsInt()
  @Min(0)
  sizeBytes!: number;
}

export class SendMessageDto {
  // Body may be empty when at least one attachment is present (checked in service).
  @IsString()
  @MaxLength(5000)
  body!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AttachmentRefDto)
  attachments?: AttachmentRefDto[];

  // When set, this message quotes/replies to another message in the same thread.
  @IsOptional()
  @IsUUID()
  replyToId?: string;
}
