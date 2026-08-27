import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';
import { UpdateSettingsDto } from './dto/update-settings.dto';

const ALL_ROLES = [
  Role.SUPER_ADMIN,
  Role.SCHOOL_ADMIN,
  Role.TEACHER,
  Role.PARENT,
  Role.STUDENT,
];

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Roles(...ALL_ROLES)
  @Get('me')
  getMine(@Req() req: any) {
    return this.settings.getMine(req.user);
  }

  @Roles(...ALL_ROLES)
  @Patch('me')
  updateMine(@Body() dto: UpdateSettingsDto, @Req() req: any) {
    return this.settings.updateMine(req.user, dto);
  }
}
