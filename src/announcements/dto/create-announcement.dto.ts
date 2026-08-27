import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AnnouncementTargetKind, AnnouncementType } from '@prisma/client';

export class AnnouncementAttachmentRefDto {
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

export class AnnouncementTargetDto {
  @IsEnum(AnnouncementTargetKind)
  kind!: AnnouncementTargetKind;

  /** ClassGrade id (CLASS) or Section id (SECTION); omit for SCHOOL / ALL_*. */
  @IsOptional()
  @IsUUID()
  refId?: string;
}

export class CreateAnnouncementDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  body!: string;

  /** Priority/type badge; defaults to GENERAL when omitted. */
  @IsOptional()
  @IsEnum(AnnouncementType)
  type?: AnnouncementType;

  /** Audience groups this announcement targets (union). At least one required. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AnnouncementTargetDto)
  targets!: AnnouncementTargetDto[];

  /** Future = scheduled; null/past = publish immediately. */
  @IsOptional()
  @IsDateString()
  publishAt?: string;

  /** SUPER_ADMIN must pass the target school explicitly. */
  @IsOptional()
  @IsUUID()
  schoolId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AnnouncementAttachmentRefDto)
  attachments?: AnnouncementAttachmentRefDto[];
}
