import { IsString, MaxLength } from 'class-validator';

/** Rename a GROUP thread. */
export class UpdateThreadDto {
  @IsString()
  @MaxLength(120)
  title!: string;
}
