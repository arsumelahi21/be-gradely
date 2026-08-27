import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Actor } from '../common/types/actor.type';
import { UpdateSettingsDto } from './dto/update-settings.dto';

/**
 * Per-user settings (notify prefs, language, theme); keyed to the authenticated
 * user only, so no cross-tenant surface. Notifications read notify* flags off this row.
 */
@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getMine(actor: Actor) {
    return this.prisma.userSettings.upsert({
      where: { userId: actor.userId },
      update: {},
      create: { userId: actor.userId },
    });
  }

  async updateMine(actor: Actor, dto: UpdateSettingsDto) {
    return this.prisma.userSettings.upsert({
      where: { userId: actor.userId },
      update: { ...dto },
      create: { userId: actor.userId, ...dto },
    });
  }
}
