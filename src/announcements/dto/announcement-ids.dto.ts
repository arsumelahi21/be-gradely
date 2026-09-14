import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

export class AnnouncementIdsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('all', { each: true })
  ids!: string[];
}
