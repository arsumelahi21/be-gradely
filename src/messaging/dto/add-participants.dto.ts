import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

export class AddParticipantsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID(undefined, { each: true })
  userIds!: string[];
}
