import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export class ParentStatementQueryDto {
  /** Narrows to one child; it must still be linked to the caller. */
  @IsOptional()
  @IsUUID()
  studentId?: string;

  @IsOptional()
  @IsUUID()
  academicYearId?: string;

  // A month alone is ambiguous: an academic year can span two calendar years.
  @ValidateIf((o: ParentStatementQueryDto) => o.periodMonth !== undefined)
  @Type(() => Number)
  @IsInt({ message: 'Choose the year of the billing month' })
  @Min(2000)
  @Max(2100)
  periodYear?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  periodMonth?: number;
}
