import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SearchService } from './search.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';
import { GlobalSearchQueryDto } from './dto/global-search-query.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  // Hit on every debounced keystroke — keep a modest per-user rate limit.
  // All five roles may search; the service scopes results to what each can see.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Roles(
    Role.SUPER_ADMIN,
    Role.SCHOOL_ADMIN,
    Role.TEACHER,
    Role.PARENT,
    Role.STUDENT,
  )
  @Get()
  global(@Query() query: GlobalSearchQueryDto, @Req() req: any) {
    return this.search.globalSearch(req.user, query.q, query.schoolId);
  }
}
