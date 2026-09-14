import { IsString, MaxLength } from 'class-validator';

export class UpdateThreadDto {
  @IsString()
  @MaxLength(120)
  title!: string;
}
