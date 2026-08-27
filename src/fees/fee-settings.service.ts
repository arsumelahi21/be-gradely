import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BaseSchoolScopedService } from '../common/services/base-school.service';
import { Actor } from '../common/types/actor.type';
import { UpdateFeeSettingsDto } from './dto/update-fee-settings.dto';

const SETTINGS_SELECT = {
  id: true,
  name: true,
  currency: true,
  feeChallanPrefix: true,
  feeDueDayOfMonth: true,
  installmentReminderEnabled: true,
  installmentReminderDaysBefore: true,
} as const;

/**
 * The five fee columns on School. A narrow endpoint rather than the existing
 * `PATCH /schools/:id`, which is SUPER_ADMIN-only — a school admin must be able
 * to set their own currency and due day.
 */
@Injectable()
export class FeeSettingsService extends BaseSchoolScopedService {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async get(actor: Actor, schoolId?: string) {
    this.ensureAdmin(actor);
    const id = this.resolveSchoolId(actor, schoolId);
    const school = await this.prisma.school.findUnique({
      where: { id },
      select: SETTINGS_SELECT,
    });
    if (!school) throw new NotFoundException('School not found');
    return school;
  }

  async update(dto: UpdateFeeSettingsDto, actor: Actor) {
    this.ensureAdmin(actor);
    const id = this.resolveSchoolId(actor, dto.schoolId);
    await this.ensureSchoolExists(id);
    return this.prisma.school.update({
      where: { id },
      data: {
        ...(dto.currency !== undefined && {
          currency: dto.currency.trim().toUpperCase(),
        }),
        ...(dto.feeChallanPrefix !== undefined && {
          feeChallanPrefix: dto.feeChallanPrefix.trim() || null,
        }),
        ...(dto.feeDueDayOfMonth !== undefined && {
          feeDueDayOfMonth: dto.feeDueDayOfMonth,
        }),
        // `!== undefined`, never truthiness — 0 days before and `false` are
        // both meaningful settings the admin must be able to save.
        ...(dto.installmentReminderEnabled !== undefined && {
          installmentReminderEnabled: dto.installmentReminderEnabled,
        }),
        ...(dto.installmentReminderDaysBefore !== undefined && {
          installmentReminderDaysBefore: dto.installmentReminderDaysBefore,
        }),
      },
      select: SETTINGS_SELECT,
    });
  }
}
