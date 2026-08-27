import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/** Body for bulk mark-read / dismiss of selected announcements. */
export class AnnouncementIdsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  ids!: string[];
}
