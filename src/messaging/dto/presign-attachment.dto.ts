import { IsInt, IsString, MaxLength, Min } from 'class-validator';

/** Request a presigned S3 PUT url for a message attachment (validated server-side). */
export class PresignAttachmentDto {
  @IsString()
  @MaxLength(255)
  fileName!: string;

  @IsString()
  @MaxLength(255)
  mimeType!: string;

  @IsInt()
  @Min(1)
  sizeBytes!: number;
}
