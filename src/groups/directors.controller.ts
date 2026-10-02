import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
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
import { DirectorsService } from './directors.service';
import {
  CreateDirectorDto,
  ListDirectorsQueryDto,
  UpdateDirectorDto,
} from './dto/group.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
@Controller('directors')
export class DirectorsController {
  constructor(private directors: DirectorsService) {}

  @Get()
  findAll(@Query() query: ListDirectorsQueryDto) {
    return this.directors.findAll(query);
  }

  @Post()
  create(@Body() dto: CreateDirectorDto, @Req() req: any) {
    return this.directors.create(dto, req.user);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.directors.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDirectorDto,
    @Req() req: any,
  ) {
    return this.directors.update(id, dto, req.user);
  }

  @Delete(':id')
  remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.directors.remove(id, req.user);
  }
}
