import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit/audit.service';
import type { StringValue } from 'ms';

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const GENERIC_RESET_RESPONSE = {
  message: 'If an account exists for that email, a reset link has been sent.',
};

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private audit: AuditLogService,
  ) {}

  private getAccessSecret(): string {
    const s = process.env.JWT_ACCESS_SECRET;
    if (!s) throw new Error('JWT_ACCESS_SECRET is not set');
    return s;
  }

  private getRefreshSecret(): string {
    const s = process.env.JWT_REFRESH_SECRET;
    if (!s) throw new Error('JWT_REFRESH_SECRET is not set');
    return s;
  }

  private getAccessExpiresIn(): StringValue | number {
    // Short-lived (PLAN.md P0-13b / Phase 1 §1.5.2): a 20-day token in localStorage is XSS-stealable; rely on refresh for longevity.
    // supports: "15m", "7d" etc
    return (process.env.JWT_ACCESS_EXPIRES_IN ?? '15m') as StringValue;
  }

  private getRefreshExpiresIn(): StringValue | number {
    return (process.env.JWT_REFRESH_EXPIRES_IN ?? '7d') as StringValue;
  }

  private signAccessToken(user: {
    id: string;
    role: string;
    schoolId: string | null;
    email: string;
  }) {
    return this.jwt.signAsync(
      {
        sub: user.id,
        role: user.role,
        schoolId: user.schoolId,
        email: user.email,
      },
      {
        secret: this.getAccessSecret(),
        expiresIn: this.getAccessExpiresIn(),
      },
    );
  }

  private signRefreshToken(user: { id: string }) {
    return this.jwt.signAsync(
      { sub: user.id },
      {
        secret: this.getRefreshSecret(),
        expiresIn: this.getRefreshExpiresIn(),
      },
    );
  }

  async login(email: string, password: string) {
    const user = await (this.prisma as any).user.findUnique({
      where: { email },
    });
    if (!user || !user.isActive)
      throw new UnauthorizedException('Invalid credentials');

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    const accessToken = await this.signAccessToken({
      id: user.id,
      role: user.role,
      schoolId: user.schoolId ?? null,
      email: user.email,
    });

    const refreshToken = await this.signRefreshToken({ id: user.id });

    await (this.prisma as any).user.update({
      where: { id: user.id },
      data: { refreshTokenHash: await bcrypt.hash(refreshToken, 10) },
    });

    // Fetch user with all profile data
    const userWithProfile = await this.prisma.user.findUnique({
      where: { id: user.id },
      include: {
        teacherProfile: true,
        parentProfile: {
          include: {
            children: {
              include: {
                student: true,
              },
            },
          },
        },
        studentProfile: {
          include: {
            parents: {
              include: {
                parent: true,
              },
            },
          },
        },
        school: true,
      },
    });

    // Return safe shape (no passwordHash/refreshTokenHash)
    const { passwordHash, refreshTokenHash, ...userData } =
      userWithProfile as any;

    void this.audit.record(user.id, 'LOGIN', {
      schoolId: user.schoolId ?? null,
      entityType: 'User',
      entityId: user.id,
    });

    return {
      accessToken,
      refreshToken,
      user: userData,
    };
  }

  async refresh(userId: string, refreshToken: string) {
    const user = await (this.prisma as any).user.findUnique({
      where: { id: userId },
    });
    if (!user || !user.refreshTokenHash)
      throw new ForbiddenException('Access denied');

    const ok = await bcrypt.compare(refreshToken, user.refreshTokenHash);
    if (!ok) throw new ForbiddenException('Access denied');

    const accessToken = await this.signAccessToken({
      id: user.id,
      role: user.role,
      schoolId: user.schoolId ?? null,
      email: user.email,
    });

    const newRefreshToken = await this.signRefreshToken({ id: user.id });

    await (this.prisma as any).user.update({
      where: { id: user.id },
      data: { refreshTokenHash: await bcrypt.hash(newRefreshToken, 10) },
    });

    return { accessToken, refreshToken: newRefreshToken };
  }

  async logout(userId: string) {
    await (this.prisma as any).user.update({
      where: { id: userId },
      data: { refreshTokenHash: null },
    });
    return { success: true };
  }

  /** Start a password reset; same response whether or not the email exists (no enumeration — Phase 1 §1.5.6). Dev: logs the link. */
  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (user && user.isActive) {
      const rawToken = randomBytes(32).toString('hex');
      const resetTokenHash = await bcrypt.hash(rawToken, 10);
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          resetTokenHash,
          resetTokenExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        },
      });
      // Token embeds the userId so reset can look the user up (the raw token
      // is never stored — only its bcrypt hash is).
      const token = `${user.id}.${rawToken}`;
      const base = process.env.FRONTEND_URL ?? 'http://localhost:3000';
      const link = `${base}/reset-password?token=${encodeURIComponent(token)}`;
      // TODO(Phase 3): send via the chosen email vendor. Dev: log the link.

      console.log(`[password-reset] ${email} -> ${link}`);
    }
    return GENERIC_RESET_RESPONSE;
  }

  async resetPassword(token: string, newPassword: string) {
    const sep = token.indexOf('.');
    if (sep <= 0) throw new BadRequestException('Invalid or expired token');
    const userId = token.slice(0, sep);
    const rawToken = token.slice(sep + 1);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (
      !user ||
      !user.resetTokenHash ||
      !user.resetTokenExpiresAt ||
      user.resetTokenExpiresAt.getTime() < Date.now()
    ) {
      throw new BadRequestException('Invalid or expired token');
    }

    const ok = await bcrypt.compare(rawToken, user.resetTokenHash);
    if (!ok) throw new BadRequestException('Invalid or expired token');

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        resetTokenHash: null,
        resetTokenExpiresAt: null,
        // Kill any existing sessions on password reset.
        refreshTokenHash: null,
      },
    });
    return { success: true };
  }

  async me(userId: string) {
    const userWithProfile = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        teacherProfile: true,
        parentProfile: {
          include: {
            children: {
              include: {
                student: true,
              },
            },
          },
        },
        studentProfile: {
          include: {
            parents: {
              include: {
                parent: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        email: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        school: true,
      },
    });

    if (!userWithProfile) {
      throw new UnauthorizedException('User not found');
    }

    // Return safe shape (no passwordHash/refreshTokenHash)
    const { passwordHash, refreshTokenHash, ...userData } =
      userWithProfile as any;

    // Include parent email from User table if parentProfile email is null
    if (userData.studentProfile && userData.studentProfile.parents) {
      userData.studentProfile.parents = userData.studentProfile.parents.map(
        (parentLink: any) => {
          const parent = parentLink.parent;
          const parentData: any = {
            ...parent,
            email: parent.email || parent.user?.email || null,
          };
          // Include userId if user relation exists
          if (parent.user) {
            parentData.userId = parent.user.id;
          }
          // Remove nested user object to avoid duplication
          delete parentData.user;
          return {
            ...parentLink,
            parent: parentData,
          };
        },
      );
    }

    return userData;
  }
}
