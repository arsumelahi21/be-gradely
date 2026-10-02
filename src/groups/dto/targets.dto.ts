import { Type } from 'class-transformer';
import {
  IsDefined,
  IsInt,
  IsObject,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/** Every field is optional: one left out inherits from the level above (branch → network → default). */
export class TargetValuesDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  attendance?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  passRate?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  collection?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  receiptsDays?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  resultsDays?: number;
}

// No groupId: the group always comes from the director's own scope.
export class UpdateTargetsDto {
  /** Omitted: the network-wide level. Otherwise one of the director's branches (404 if not). */
  @IsOptional()
  @IsUUID()
  branchId?: string;

  /** Replaces that level; `{}` clears it back to inheriting. */
  // Without IsObject an array passes, each element validated as a nested DTO.
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => TargetValuesDto)
  targets: TargetValuesDto;
}
