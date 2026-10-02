import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { PRESETS } from '../insights';
import type { Preset } from '../insights';

// No schoolId: a branch is resolved against the director's own scope, never trusted.
export class InsightsQueryDto {
  /** 'all' or one of the director's branch ids; anything else is a 404. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  branch?: string;

  /** 'all' or one of the director's groups; narrows the branches before `branch` applies. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  group?: string;

  @IsOptional()
  @IsIn(['current', 'previous'])
  ay?: 'current' | 'previous';

  @IsOptional()
  @IsIn(PRESETS)
  preset?: Preset;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeSuspended?: boolean;
}
