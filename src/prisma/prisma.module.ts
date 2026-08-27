import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { PrismaWarmerService } from './prisma-warmer.service';

@Global()
@Module({
  providers: [PrismaService, PrismaWarmerService],
  exports: [PrismaService],
})
export class PrismaModule {}
