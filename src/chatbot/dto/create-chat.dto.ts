import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Starting a chat with a question is one round trip instead of two — which is
 * what Quick Ask does on its first send.
 */
export class CreateChatDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000, { message: 'Message is too long (2000 characters max)' })
  message?: string;
}
