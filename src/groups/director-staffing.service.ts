import { Injectable } from '@nestjs/common';
import { TimetableService } from '../academics/timetable/timetable.service';
import {
  BranchContext,
  BranchResult,
  DirectorScope,
  DirectorService,
} from './director.service';
import { DirectorQueriesService } from './director.queries';
import { InsightsQueryDto } from './dto/insights-query.dto';
import { Ratio, ratio, resolveWindow } from './insights';

interface Coverage {
  count: number;
  of: number;
}

export interface StaffingData {
  /** Teachers who can sign in and are active, right now. */
  teachers: number;
  studentsPerTeacher: {
    students: number;
    teachers: number;
    value: number | null;
  } | null;
  subjectsWithoutTeacher: Coverage | null;
  sectionsWithoutClassTeacher: Coverage | null;
  timetables: { published: number; sections: number; share: Ratio } | null;
  /** Teachers who joined and left in the last 90 days, whatever the page filter. */
  turnover: { joined: number; left: number };
}

export interface StaffingGroup {
  teachers: number;
  studentsPerTeacher: {
    students: number;
    teachers: number;
    value: number | null;
  };
  subjectsWithoutTeacher: Coverage;
  sectionsWithoutClassTeacher: Coverage;
  timetables: { published: number; sections: number; share: Ratio };
  turnover: { joined: number; left: number };
}

const perTeacher = (students: number, teachers: number) => ({
  students,
  teachers,
  value: teachers === 0 ? null : Math.round((students / teachers) * 10) / 10,
});

/** Staffing & Timetable (07-STAFFING.md): enough teachers, every class covered, timetables out. */
@Injectable()
export class DirectorStaffingService {
  constructor(
    private director: DirectorService,
    private queries: DirectorQueriesService,
    private timetable: TimetableService,
  ) {}

  insights(scope: DirectorScope, query: InsightsQueryDto) {
    return this.director.insights<StaffingData, StaffingGroup>(
      scope,
      query,
      (ctx) => this.branchStaffing(ctx),
      (rows) => this.rollUp(rows),
    );
  }

  async branchStaffing(ctx: BranchContext): Promise<StaffingData> {
    const { actor, branch, year, now } = ctx;
    const last90 = resolveWindow({ preset: '90d' }, now);
    const [staff, enrolment, overview, joined, left] = await Promise.all([
      this.queries.staffing(branch.id, year?.id ?? null),
      year ? this.queries.enrolment(branch.id, year.id) : null,
      // getOverview throws without a session, and it has no cache of its own (00 §9).
      year
        ? this.queries.cached(branch.id, 'tt', { ay: year.id }, 60, () =>
            this.timetable.getOverview(actor, { academicYearId: year.id }),
          )
        : null,
      this.queries.teacherJoiners(branch.id, last90),
      this.queries.leavers(branch.id, 'TEACHER', last90),
    ]);
    const turnover = { joined, left };
    if (!year || !enrolment || !overview)
      return {
        teachers: staff.teachers,
        turnover,
        studentsPerTeacher: null,
        subjectsWithoutTeacher: null,
        sectionsWithoutClassTeacher: null,
        timetables: null,
      };

    const { published, total } = overview.counts;
    return {
      teachers: staff.teachers,
      turnover,
      studentsPerTeacher: perTeacher(
        enrolment.reduce((s, r) => s + r.n, 0),
        staff.teachers,
      ),
      subjectsWithoutTeacher: { count: staff.uncovered, of: staff.offerings },
      sectionsWithoutClassTeacher: {
        count: staff.noClassTeacher,
        of: staff.sections,
      },
      timetables: {
        published,
        sections: total,
        share: ratio(published, total),
      },
    };
  }

  private rollUp(rows: BranchResult<StaffingData>[]): StaffingGroup {
    const group = {
      teachers: 0,
      students: 0,
      sessionTeachers: 0,
      subjects: { count: 0, of: 0 },
      classTeachers: { count: 0, of: 0 },
      published: 0,
      sections: 0,
      turnover: { joined: 0, left: 0 },
    };
    for (const { status, data } of rows) {
      if (!data) continue;
      group.teachers += data.teachers;
      group.turnover.joined += data.turnover.joined;
      group.turnover.left += data.turnover.left;
      if (status !== 'ok' || !data.studentsPerTeacher) continue;
      // Ratio of the same branches: students and teachers both from branches with a session.
      group.students += data.studentsPerTeacher.students;
      group.sessionTeachers += data.studentsPerTeacher.teachers;
      group.subjects.count += data.subjectsWithoutTeacher?.count ?? 0;
      group.subjects.of += data.subjectsWithoutTeacher?.of ?? 0;
      group.classTeachers.count += data.sectionsWithoutClassTeacher?.count ?? 0;
      group.classTeachers.of += data.sectionsWithoutClassTeacher?.of ?? 0;
      group.published += data.timetables?.published ?? 0;
      group.sections += data.timetables?.sections ?? 0;
    }
    return {
      teachers: group.teachers,
      turnover: group.turnover,
      studentsPerTeacher: perTeacher(group.students, group.sessionTeachers),
      subjectsWithoutTeacher: group.subjects,
      sectionsWithoutClassTeacher: group.classTeachers,
      timetables: {
        published: group.published,
        sections: group.sections,
        share: ratio(group.published, group.sections),
      },
    };
  }
}
