import { IsString, MaxLength, MinLength } from 'class-validator';

/** One question. Bounded so a demo store can't be filled with a giant payload. */
export class SendMessageDto {
  @IsString()
  @MinLength(1, { message: 'Message cannot be empty' })
  @MaxLength(2000, { message: 'Message is too long (2000 characters max)' })
  content: string;
}
