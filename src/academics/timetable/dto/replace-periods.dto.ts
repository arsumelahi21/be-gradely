import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PeriodKind } from '../../../common/types/timetable.type';
import { MINUTES_IN_DAY } from '../timetable-time';

export class PeriodInputDto {
  @IsInt()
  @Min(1)
  @Max(50)
  index: number;

  @IsOptional()
  @IsString()
  label?: string;

  @IsInt()
  @Min(0)
  @Max(MINUTES_IN_DAY)
  startMin: number;

  @IsInt()
  @Min(0)
  @Max(MINUTES_IN_DAY)
  endMin: number;

  @IsOptional()
  @IsEnum(PeriodKind)
  kind?: PeriodKind;
}

/** Bulk-replace the whole bell schedule of a section (drives edit-all/recalculate). */
export class ReplacePeriodsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PeriodInputDto)
  periods: PeriodInputDto[];
}
