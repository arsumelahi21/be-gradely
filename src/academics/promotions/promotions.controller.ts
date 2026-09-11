import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PromotionsService } from './promotions.service';
import { FindPromotionStudentsQueryDto } from './dto/find-promotion-students-query.dto';
import { FindDestinationQueryDto } from './dto/find-destination-query.dto';
import { PromotionPlanDto } from './dto/promotion-plan.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/types/role.type';

/** Class promotion / demotion. Admin-only: it rewrites where students sit. */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('promotions')
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('students')
  listStudents(@Query() query: FindPromotionStudentsQueryDto, @Req() req: any) {
    return this.promotions.listSourceStudents(query, req.user);
  }

  /** Who already sits in the destination class, for the target session. */
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get('destination')
  destination(@Query() query: FindDestinationQueryDto, @Req() req: any) {
    return this.promotions.listDestination(query, req.user);
  }

  /** The confirmation summary. Writes nothing. */
  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post('preview')
  preview(@Body() dto: PromotionPlanDto, @Req() req: any) {
    return this.promotions.preview(dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post('execute')
  execute(@Body() dto: PromotionPlanDto, @Req() req: any) {
    return this.promotions.execute(dto, req.user);
  }
}
