import { IsString, Length } from 'class-validator';

export class ReactionDto {
  // A single emoji. Length-bounded (emoji can be multi-codepoint); rendered as
  // plain text in a chip, so no markup risk.
  @IsString()
  @Length(1, 16)
  emoji!: string;
}
