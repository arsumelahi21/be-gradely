import { Module } from '@nestjs/common';
import { TeachersController } from './teachers/teachers.controller';
import { TeachersService } from './teachers/teachers.service';
import { TeacherQualificationsController } from './teacher-qualifications/teacher-qualifications.controller';
import { TeacherQualificationsService } from './teacher-qualifications/teacher-qualifications.service';
import { TeacherSubjectSpecialtiesController } from './teacher-subject-specialties/teacher-subject-specialties.controller';
import { TeacherSubjectSpecialtiesService } from './teacher-subject-specialties/teacher-subject-specialties.service';

@Module({
  controllers: [
    TeachersController,
    TeacherQualificationsController,
    TeacherSubjectSpecialtiesController,
  ],
  providers: [
    TeachersService,
    TeacherQualificationsService,
    TeacherSubjectSpecialtiesService,
  ],
  exports: [
    TeachersService,
    TeacherQualificationsService,
    TeacherSubjectSpecialtiesService,
  ],
})
export class TeachersModule {}
