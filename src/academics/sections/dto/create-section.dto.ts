import { FeeBillingMode } from '@prisma/client';
import { IsString, IsUUID, IsOptional, IsEnum } from 'class-validator';

export class CreateSectionDto {
  @IsUUID()
  classGradeId: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  room?: string;

  @IsOptional()
  @IsEnum(FeeBillingMode, {
    message: 'Choose class-wise or subject-wise billing',
  })
  feeBillingMode?: FeeBillingMode;
}
