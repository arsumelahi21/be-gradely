import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListNotificationsQueryDto extends PaginationQueryDto {
  /** When true, return only unread notifications. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  unreadOnly?: boolean;

  /** ISO timestamp — only notifications created on/after it (the bell sends the
   *  start of the local day so it shows "today only"). */
  @IsOptional()
  @IsDateString()
  since?: string;
}
