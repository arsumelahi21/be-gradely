import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';

export const tooManyAttempts = (seconds: number) =>
  `Too many attempts. Please wait ${seconds} second${seconds === 1 ? '' : 's'} and try again.`;

/**
 * Rate-limits a signed-in user on their own budget rather than their IP's: a
 * school sits behind one address, so a per-IP limit throttles everyone there at once.
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  private readonly jwt = new JwtService();

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const token = /^Bearer (.+)$/.exec(req.headers?.authorization ?? '')?.[1];
    if (token) {
      // Verified, not decoded: a forged `sub` must not spend someone else's budget.
      const payload = await this.jwt
        .verifyAsync<{ sub?: string }>(token, {
          secret: process.env.JWT_ACCESS_SECRET,
        })
        .catch(() => null);
      if (payload?.sub) return `user:${payload.sub}`;
    }
    return req.ip;
  }
}
