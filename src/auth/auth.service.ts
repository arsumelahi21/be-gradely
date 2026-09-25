import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  InjectThrottlerStorage,
  ThrottlerException,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit/audit.service';
import { tooManyAttempts } from './guards/user-throttler.guard';
import type { StringValue } from 'ms';

// ponytail: counts successful sign-ins too, so a class of more than 30 on one
// network waits up to a minute; count only failures if that bites.
const LOGINS_PER_NETWORK_PER_MINUTE = 30;
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
    @InjectThrottlerStorage() private throttle: ThrottlerStorage,
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

  async login(email: string, password: string, ip: string) {
    // The route limits each account; this stops one network guessing across
    // many accounts (password spraying), which a per-account limit never sees.
    const { isBlocked, timeToBlockExpire } = await this.throttle.increment(
      `login-network:${ip}`,
      60_000,
      LOGINS_PER_NETWORK_PER_MINUTE,
      60_000,
      'login-network',
    );
    if (isBlocked)
      throw new ThrottlerException(tooManyAttempts(timeToBlockExpire));

    const user = await (this.prisma as any).user.findUnique({
      where: { email },
      omit: { passwordHash: false },
      include: { school: { select: { isActive: true } } },
    });
    // Super admins have no school, so only an explicit `false` locks a user out.
    if (!user?.isActive || user.school?.isActive === false)
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

    void this.audit.record(user.id, 'LOGIN', {
      schoolId: user.schoolId ?? null,
      entityType: 'User',
      entityId: user.id,
    });

    return {
      accessToken,
      refreshToken,
      user: userWithProfile,
    };
  }

  async refresh(userId: string, refreshToken: string) {
    const user = await (this.prisma as any).user.findUnique({
      where: { id: userId },
      omit: { refreshTokenHash: false },
      include: { school: { select: { isActive: true } } },
    });
    // Without this, a deactivated user or a suspended school keeps renewing tokens forever.
    // ponytail: an already-issued access token stays valid ≤ JWT_ACCESS_EXPIRES_IN; add a JwtStrategy state check if instant revocation is required.
    if (
      !user?.isActive ||
      user.school?.isActive === false ||
      !user.refreshTokenHash
    )
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

  /** Start a password reset; same response whether or not the email exists (no enumeration — Phase 1 §1.5.6). Logs the link only when NODE_ENV=development. */
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
      // Opt in, never opt out: production sets no NODE_ENV, and this link grants account takeover.
      if (process.env.NODE_ENV === 'development')
        console.log(`[password-reset] ${email} -> ${link}`);
    }
    return GENERIC_RESET_RESPONSE;
  }

  async resetPassword(token: string, newPassword: string) {
    const sep = token.indexOf('.');
    if (sep <= 0) throw new BadRequestException('Invalid or expired token');
    const userId = token.slice(0, sep);
    const rawToken = token.slice(sep + 1);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      omit: { resetTokenHash: false, resetTokenExpiresAt: false },
    });
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

    const userData = userWithProfile as any;

    if (userData.studentProfile && userData.studentProfile.parents) {
      userData.studentProfile.parents = userData.studentProfile.parents.map(
        (parentLink: any) => {
          const parent = parentLink.parent;
          const parentData: any = {
            ...parent,
            email: parent.email || parent.user?.email || null,
          };
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
