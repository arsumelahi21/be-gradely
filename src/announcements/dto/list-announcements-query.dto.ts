import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { AnnouncementType } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListAnnouncementsQueryDto extends PaginationQueryDto {
  /** SUPER_ADMIN scopes the feed to a specific school. */
  @IsOptional()
  @IsUUID()
  schoolId?: string;

  /** Filter to a single announcement type. */
  @IsOptional()
  @IsEnum(AnnouncementType)
  type?: AnnouncementType;

  /** When true, return only unread (not-yet-opened) announcements. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  unreadOnly?: boolean;
}
