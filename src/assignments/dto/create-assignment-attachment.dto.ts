import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CreateAssignmentAttachmentDto {
  @IsOptional()
  @IsString()
  fileName?: string;

  @IsOptional()
  @IsString()
  mimeType?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sizeBytes?: number;
}
