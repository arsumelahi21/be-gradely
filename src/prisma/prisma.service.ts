import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    // Keeps credential columns out of every response and cache by default; auth opts back in per query.
    super({
      omit: {
        user: {
          passwordHash: true,
          refreshTokenHash: true,
          resetTokenHash: true,
          resetTokenExpiresAt: true,
        },
      },
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
