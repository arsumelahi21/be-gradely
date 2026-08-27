import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

/** Add users to an existing GROUP thread. */
export class AddParticipantsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID(undefined, { each: true })
  userIds!: string[];
}
