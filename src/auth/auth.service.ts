import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  InjectThrottlerStorage,
  ThrottlerException,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit/audit.service';
import { tooManyAttempts } from './guards/user-throttler.guard';
import type { StringValue } from 'ms';

// Failures only: a spray is all failures, while a class arriving together is
// not, and counting their successes locked out everyone behind the school's IP.
const FAILED_LOGINS_PER_NETWORK_PER_MINUTE = 30;

// Compared against when the email is unknown, so the response takes as long
// as a wrong password and doesn't reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('timing-only', 10);

// bcrypt reads only the first 72 bytes, which every JWT for one user shares
// (header + sub), so it hashes a digest of the whole token instead.
export const refreshTokenDigest = (token: string) =>
  createHash('sha256').update(token).digest('hex');

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
    mustChangePassword: boolean;
  }) {
    return this.jwt.signAsync(
      {
        sub: user.id,
        typ: 'access',
        role: user.role,
        schoolId: user.schoolId,
        email: user.email,
        // Carried in the token so MustChangePasswordInterceptor costs no query.
        mustChangePassword: user.mustChangePassword,
      },
      {
        secret: this.getAccessSecret(),
        expiresIn: this.getAccessExpiresIn(),
      },
    );
  }

  private signRefreshToken(user: { id: string }) {
    return this.jwt.signAsync(
      { sub: user.id, typ: 'refresh' },
      {
        secret: this.getRefreshSecret(),
        expiresIn: this.getRefreshExpiresIn(),
        // Two tokens signed in the same second would otherwise be identical,
        // and rotation couldn't retire the one presented.
        jwtid: randomUUID(),
      },
    );
  }

  /**
   * The route limits each account; this counts a network's failures across all
   * of them, which is what a per-account limit can never see (password spraying).
   */
  private async rejectFailedLogin(ip: string): Promise<never> {
    const { isBlocked, timeToBlockExpire } = await this.throttle.increment(
      `login-network:${ip}`,
      60_000,
      FAILED_LOGINS_PER_NETWORK_PER_MINUTE,
      60_000,
      'login-network',
    );
    if (isBlocked)
      throw new ThrottlerException(tooManyAttempts(timeToBlockExpire));
    throw new UnauthorizedException('Invalid credentials');
  }

  async login(email: string, password: string, ip: string) {
    const user = await (this.prisma as any).user.findUnique({
      where: { email },
      omit: { passwordHash: false },
      include: { school: { select: { isActive: true } } },
    });
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    // Super admins have no school, so only an explicit `false` locks a user out.
    if (!ok || !user?.isActive || user.school?.isActive === false)
      await this.rejectFailedLogin(ip);

    const accessToken = await this.signAccessToken({
      id: user.id,
      role: user.role,
      schoolId: user.schoolId ?? null,
      email: user.email,
      mustChangePassword: user.mustChangePassword,
    });

    const refreshToken = await this.signRefreshToken({ id: user.id });

    await (this.prisma as any).user.update({
      where: { id: user.id },
      data: {
        refreshTokenHash: await bcrypt.hash(
          refreshTokenDigest(refreshToken),
          10,
        ),
      },
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

    const ok = await bcrypt.compare(
      refreshTokenDigest(refreshToken),
      user.refreshTokenHash,
    );
    if (!ok) throw new ForbiddenException('Access denied');

    const accessToken = await this.signAccessToken({
      id: user.id,
      role: user.role,
      schoolId: user.schoolId ?? null,
      email: user.email,
      mustChangePassword: user.mustChangePassword,
    });

    const newRefreshToken = await this.signRefreshToken({ id: user.id });

    await (this.prisma as any).user.update({
      where: { id: user.id },
      data: {
        refreshTokenHash: await bcrypt.hash(
          refreshTokenDigest(newRefreshToken),
          10,
        ),
      },
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
