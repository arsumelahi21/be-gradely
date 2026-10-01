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
  CreateDirectorDto,
  GroupNameDto,
  ListGroupsQueryDto,
} from './dto/group.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
@Controller('groups')
export class GroupsController {
  constructor(private groups: GroupsService) {}

  @Post()
  create(@Body() dto: GroupNameDto, @Req() req: any) {
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
  rename(@Param('id') id: string, @Body() dto: GroupNameDto, @Req() req: any) {
    return this.groups.rename(id, dto, req.user);
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

  @Post(':id/directors')
  createDirector(
    @Param('id') id: string,
    @Body() dto: CreateDirectorDto,
    @Req() req: any,
  ) {
    return this.groups.createDirector(id, dto, req.user);
  }
}
