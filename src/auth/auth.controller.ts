import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { AllowWithTemporaryPassword } from './decorators/allow-with-temporary-password.decorator';

@Controller('auth')
export class AuthController {
  constructor(
    private auth: AuthService,
    private jwt: JwtService,
  ) {}

  // Tight limit on the brute-force target: 5 attempts/min/IP (PLAN.md P0-13a / Phase 1 §1.5.1).
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  @Post('refresh')
  async refresh(@Body() dto: RefreshDto) {
    const payload = await this.jwt
      .verifyAsync(dto.refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET,
      })
      .catch(() => {
        throw new UnauthorizedException('Invalid refresh token');
      });
    return this.auth.refresh(payload.sub, dto.refreshToken);
  }

  @AllowWithTemporaryPassword()
  @UseGuards(JwtAuthGuard)
  @Post('logout')
  logout(@Req() req: any) {
    return this.auth.logout(req.user.userId);
  }

  @AllowWithTemporaryPassword()
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: any) {
    return this.auth.me(req.user.userId);
  }
}
