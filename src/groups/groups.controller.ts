import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';
import { GroupsService } from './groups.service';
import {
  AttachSchoolDto,
  CreateGroupDto,
  ListGroupsQueryDto,
  UpdateGroupDto,
} from './dto/group.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
@Controller('groups')
export class GroupsController {
  constructor(private groups: GroupsService) {}

  @Post()
  create(@Body() dto: CreateGroupDto, @Req() req: any) {
    return this.groups.create(dto, req.user);
  }

  @Get()
  findAll(@Query() query: ListGroupsQueryDto) {
    return this.groups.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.groups.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateGroupDto,
    @Req() req: any,
  ) {
    return this.groups.update(id, dto, req.user);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.groups.remove(id, req.user);
  }

  @Post(':id/schools')
  attachSchool(
    @Param('id') id: string,
    @Body() dto: AttachSchoolDto,
    @Req() req: any,
  ) {
    return this.groups.attachSchool(id, dto.schoolId, req.user);
  }

  @Delete(':id/schools/:schoolId')
  detachSchool(
    @Param('id') id: string,
    @Param('schoolId') schoolId: string,
    @Req() req: any,
  ) {
    return this.groups.detachSchool(id, schoolId, req.user);
  }

  @Delete(':id/targets')
  resetTargets(@Param('id') id: string, @Req() req: any) {
    return this.groups.resetTargets(id, req.user);
  }
}
