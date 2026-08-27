import { PartialType } from '@nestjs/swagger';
import { CreateFeeHeadDto } from './create-fee-head.dto';

export class UpdateFeeHeadDto extends PartialType(CreateFeeHeadDto) {}
