import { Injectable } from '@nestjs/common';
import { DirectorScope, DirectorService } from './director.service';
import { DirectorQueriesService } from './director.queries';
import {
  AcademicsData,
  DirectorAcademicsService,
} from './director-academics.service';
import {
  AttendanceData,
  DirectorAttendanceService,
} from './director-attendance.service';
import { DirectorFeesService, FeesData } from './director-fees.service';
import {
  DirectorPrincipalsService,
  PrincipalRow,
} from './director-principals.service';
import {
  DirectorStaffingService,
  StaffingData,
} from './director-staffing.service';
import {
  DirectorStudentsService,
  StudentsData,
} from './director-students.service';

export interface MapData {
  students: StudentsData;
  attendance: AttendanceData;
  fees: FeesData;
  academics: AcademicsData;
  staffing: StaffingData;
  principals: PrincipalRow[];
  exams: {
    draft: number;
    review: number;
    marking: number;
    final: number;
  } | null;
}

/**
 * The network map's leaves for one branch: every tab's figures for that branch in one request,
 * through the tabs' own loaders, so the map can never show a number the tabs don't.
 */
@Injectable()
export class DirectorMapService {
  constructor(
    private director: DirectorService,
    private queries: DirectorQueriesService,
    private students: DirectorStudentsService,
    private attendanceTab: DirectorAttendanceService,
    private fees: DirectorFeesService,
    private academics: DirectorAcademicsService,
    private staffing: DirectorStaffingService,
    private principals: DirectorPrincipalsService,
  ) {}

  branch(scope: DirectorScope, branchId: string) {
    return this.director.insights<MapData, null>(
      scope,
      // One named branch: the tabs add their single-branch detail (fees and sections by class).
      { branch: branchId },
      async (ctx) => {
        const [
          students,
          attendance,
          fees,
          academics,
          staffing,
          principals,
          exams,
        ] = await Promise.all([
          this.students.branchStudents(ctx),
          this.attendanceTab.branchAttendance(ctx),
          this.fees.branchFees(ctx),
          this.academics.branchAcademics(ctx),
          this.staffing.branchStaffing(ctx),
          this.principals.branchPrincipals(ctx),
          ctx.year
            ? this.queries.examPipeline(ctx.branch.id, ctx.year.id)
            : null,
        ]);
        return {
          students,
          attendance,
          fees,
          academics,
          staffing,
          principals: principals.principals,
          exams,
        };
      },
      () => null,
    );
  }
}
