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
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateMeDto } from './dto/update-me.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { FindUsersQueryDto } from './dto/find-users-query.dto';
import { LinkParentStudentDto } from './dto/link-parent-student.dto';
import { SetActiveDto } from './dto/set-active.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(private users: UsersService) {}

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Post()
  create(@Body() dto: CreateUserDto, @Req() req: any) {
    return this.users.create(dto, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Get()
  findAll(@Query() query: FindUsersQueryDto, @Req() req: any) {
    return this.users.findAll(req.user, query.role, {
      page: query.page,
      pageSize: query.pageSize,
      search: query.search,
    });
  }

  @Roles(
    Role.SUPER_ADMIN,
    Role.SCHOOL_ADMIN,
    Role.TEACHER,
    Role.STUDENT,
    Role.PARENT,
  )
  @Get('me')
  getMe(@Req() req: any) {
    return this.users.findById(req.user.userId, req.user);
  }

  @Roles(
    Role.SUPER_ADMIN,
    Role.SCHOOL_ADMIN,
    Role.TEACHER,
    Role.STUDENT,
    Role.PARENT,
  )
  @Get(':id')
  findById(@Param('id') id: string, @Req() req: any) {
    return this.users.findById(id, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Patch(':id/active')
  setActive(
    @Param('id') id: string,
    @Body() dto: SetActiveDto,
    @Req() req: any,
  ) {
    return this.users.setActive(id, dto.isActive, req.user);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: any) {
    return this.users.remove(id, req.user);
  }

  // Self-service profile edit — any authenticated role edits their OWN record.
  // Declared before @Patch(':id') so "me" isn't captured as an id.
  @Roles(
    Role.SUPER_ADMIN,
    Role.SCHOOL_ADMIN,
    Role.TEACHER,
    Role.STUDENT,
    Role.PARENT,
  )
  @Patch('me')
  updateMe(@Body() dto: UpdateMeDto, @Req() req: any) {
    return this.users.updateMe(req.user, dto);
  }

  // Self-service password change (verifies current password). Two-segment path,
  // so it never collides with @Patch(':id').
  @Roles(
    Role.SUPER_ADMIN,
    Role.SCHOOL_ADMIN,
    Role.TEACHER,
    Role.STUDENT,
    Role.PARENT,
  )
  @Patch('me/password')
  changePassword(@Body() dto: ChangePasswordDto, @Req() req: any) {
    return this.users.changeMyPassword(req.user, dto);
  }

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateUserDto, @Req() req: any) {
    return this.users.update(id, dto, req.user);
  }

  @Roles(Role.SCHOOL_ADMIN)
  @Post('link-parent-student')
  linkParentStudent(@Body() dto: LinkParentStudentDto, @Req() req: any) {
    return this.users.linkParentStudent(
      dto.parentProfileId,
      dto.studentProfileId,
      req.user,
      dto.relationship,
    );
  }

  // Unlink a guardian from a student (a student keeps at least one guardian).
  @Roles(Role.SCHOOL_ADMIN)
  @Delete('students/:studentProfileId/parents/:parentProfileId')
  unlinkParentStudent(
    @Param('studentProfileId') studentProfileId: string,
    @Param('parentProfileId') parentProfileId: string,
    @Req() req: any,
  ) {
    return this.users.unlinkParentStudent(
      parentProfileId,
      studentProfileId,
      req.user,
    );
  }

  // ---- Student photo (stored in the DB) ----
  // :studentId is the StudentProfile id (available from the create/read response).

  @Roles(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN, Role.STUDENT)
  @Post('students/:studentId/photo')
  @UseInterceptors(
    FileInterceptor('photo', {
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
    }),
  )
  uploadStudentPhoto(
    @Param('studentId') studentId: string,
    @UploadedFile() file: { buffer: Buffer; mimetype: string } | undefined,
    @Req() req: any,
  ) {
    return this.users.uploadStudentPhoto(studentId, file, req.user);
  }

  @Roles(
    Role.SUPER_ADMIN,
    Role.SCHOOL_ADMIN,
    Role.TEACHER,
    Role.STUDENT,
    Role.PARENT,
  )
  @Get('students/:studentId/photo')
  async getStudentPhoto(
    @Param('studentId') studentId: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const { data, mimeType } = await this.users.getStudentPhoto(
      studentId,
      req.user,
    );
    res.setHeader('Content-Type', mimeType);
    // Never cache: a re-uploaded photo must show everywhere on the next fetch
    // (photos are compressed to KBs, so refetching per view is cheap).
    res.setHeader('Cache-Control', 'no-store');
    res.send(data);
  }
}
