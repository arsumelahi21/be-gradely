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

  // Per account on each network: per IP alone, one pupil's typos locked out the
  // whole school behind that address. AuthService.login adds the per-network cap.
  @Throttle({
    default: {
      limit: 5,
      ttl: 60_000,
      getTracker: (req) =>
        `${req.ip}:${String(req.body?.email ?? '')
          .trim()
          .toLowerCase()}`,
    },
  })
  @Post('login')
  login(@Body() dto: LoginDto, @Req() req: any) {
    return this.auth.login(dto.email, dto.password, req.ip);
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
    if (payload.typ === 'access') {
      throw new UnauthorizedException('Invalid refresh token');
    }
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
