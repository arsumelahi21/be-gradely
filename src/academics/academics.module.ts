import { Module } from '@nestjs/common';
import { AcademicYearsController } from './academic-years/academic-years.controller';
import { AcademicYearsService } from './academic-years/academic-years.service';
import { ClassGradesController } from './class-grades/class-grades.controller';
import { ClassGradesService } from './class-grades/class-grades.service';
import { SectionsController } from './sections/sections.controller';
import { SectionsService } from './sections/sections.service';
import { SubjectsController } from './subjects/subjects.controller';
import { SubjectsService } from './subjects/subjects.service';
import { StudentsController } from './students/students.controller';
import { StudentsService } from './students/students.service';
import { EnrollmentsController } from './enrollments/enrollments.controller';
import { EnrollmentsService } from './enrollments/enrollments.service';
import { SectionSubjectsController } from './section-subjects/section-subjects.controller';
import { SectionSubjectsService } from './section-subjects/section-subjects.service';
import { TimetableController } from './timetable/timetable.controller';
import { TimetableService } from './timetable/timetable.service';

@Module({
  controllers: [
    AcademicYearsController,
    ClassGradesController,
    SectionsController,
    SubjectsController,
    StudentsController,
    EnrollmentsController,
    SectionSubjectsController,
    TimetableController,
  ],
  providers: [
    AcademicYearsService,
    ClassGradesService,
    SectionsService,
    SubjectsService,
    StudentsService,
    EnrollmentsService,
    SectionSubjectsService,
    TimetableService,
  ],
  exports: [
    AcademicYearsService,
    ClassGradesService,
    SectionsService,
    SubjectsService,
    StudentsService,
    EnrollmentsService,
    SectionSubjectsService,
    TimetableService,
  ],
})
export class AcademicsModule {}
