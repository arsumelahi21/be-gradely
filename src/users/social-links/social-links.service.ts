import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Actor } from '../../common/types/actor.type';
import { Role } from '../../common/types/role.type';
import { CreateSocialLinkDto } from './dto/create-social-link.dto';
import { UpdateSocialLinkDto } from './dto/update-social-link.dto';

@Injectable()
export class SocialLinksService {
  constructor(private prisma: PrismaService) {}

  private get socialLinks() {
    // Cast to any so we can access the generated delegate even if types are stale.
    return (this.prisma as PrismaService & { socialLink: any }).socialLink;
  }

  async list(userId: string, actor: Actor) {
    const user = await this.getUserOrThrow(userId);
    this.guardAccess(user, actor);
    return this.socialLinks.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(userId: string, dto: CreateSocialLinkDto, actor: Actor) {
    const user = await this.getUserOrThrow(userId);
    this.guardAccess(user, actor);
    return this.socialLinks.create({
      data: {
        userId: user.id,
        teacherProfileId: user.teacherProfile?.id ?? null,
        studentProfileId: user.studentProfile?.id ?? null,
        parentProfileId: user.parentProfile?.id ?? null,
        schoolId: user.schoolId,
        platform: dto.platform,
        url: dto.url,
        label: dto.label ?? null,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async update(
    userId: string,
    linkId: string,
    dto: UpdateSocialLinkDto,
    actor: Actor,
  ) {
    const user = await this.getUserOrThrow(userId);
    this.guardAccess(user, actor);
    const link = await this.socialLinks.findUnique({ where: { id: linkId } });
    if (!link || link.userId !== user.id) {
      throw new NotFoundException('Social link not found');
    }
    return this.socialLinks.update({
      where: { id: linkId },
      data: {
        ...(dto.platform !== undefined && { platform: dto.platform }),
        ...(dto.url !== undefined && { url: dto.url }),
        ...(dto.label !== undefined && { label: dto.label }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
  }

  async remove(userId: string, linkId: string, actor: Actor) {
    const user = await this.getUserOrThrow(userId);
    this.guardAccess(user, actor);
    const link = await this.socialLinks.findUnique({ where: { id: linkId } });
    if (!link || link.userId !== user.id) {
      throw new NotFoundException('Social link not found');
    }
    await this.socialLinks.delete({ where: { id: linkId } });
    return { success: true };
  }

  private async getUserOrThrow(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        teacherProfile: true,
        studentProfile: true,
        parentProfile: true,
      },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  private guardAccess(user: any, actor: Actor) {
    if (![Role.SUPER_ADMIN, Role.SCHOOL_ADMIN].includes(actor.role)) {
      throw new ForbiddenException('Not allowed');
    }
    if (actor.role === Role.SCHOOL_ADMIN) {
      if (!actor.schoolId || user.schoolId !== actor.schoolId) {
        throw new ForbiddenException('Cross-school access denied');
      }
      if (user.role === Role.SUPER_ADMIN || user.role === Role.SCHOOL_ADMIN) {
        throw new ForbiddenException('Cannot manage admin social links');
      }
    }
  }
}
