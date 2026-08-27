import { IsArray, IsString } from 'class-validator';

/** Bulk mark-as-read by id (e.g. a per-category "mark all read" in the bell). */
export class MarkNotificationsReadDto {
  @IsArray()
  @IsString({ each: true })
  ids: string[];
}
