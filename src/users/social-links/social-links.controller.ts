import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SocialLinksService } from './social-links.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/types/role.type';
import { CreateSocialLinkDto } from './dto/create-social-link.dto';
import { UpdateSocialLinkDto } from './dto/update-social-link.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
@Controller('users/:userId/social-links')
export class SocialLinksController {
  constructor(private readonly links: SocialLinksService) {}

  @Get()
  list(@Param('userId') userId: string, @Req() req: any) {
    return this.links.list(userId, req.user);
  }

  @Post()
  create(
    @Param('userId') userId: string,
    @Body() dto: CreateSocialLinkDto,
    @Req() req: any,
  ) {
    return this.links.create(userId, dto, req.user);
  }

  @Patch(':linkId')
  update(
    @Param('userId') userId: string,
    @Param('linkId') linkId: string,
    @Body() dto: UpdateSocialLinkDto,
    @Req() req: any,
  ) {
    return this.links.update(userId, linkId, dto, req.user);
  }

  @Delete(':linkId')
  remove(
    @Param('userId') userId: string,
    @Param('linkId') linkId: string,
    @Req() req: any,
  ) {
    return this.links.remove(userId, linkId, req.user);
  }
}
