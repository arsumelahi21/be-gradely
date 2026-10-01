import { BadRequestException, Injectable } from '@nestjs/common';
import { AttendanceService } from '../attendance/attendance.service';
import { AuditLogService } from '../audit/audit.service';
import {
  BranchContext,
  BranchResult,
  DirectorScope,
  DirectorService,
} from './director.service';
import { DirectorQueriesService } from './director.queries';
import { InsightsQueryDto } from './dto/insights-query.dto';
import { Ratio, nthWorkingDayBack, ratio, ymd } from './insights';

// 00 §7: a section that took no register over the last 5 working days is "not marking".
const UNMARKED_WORKING_DAYS = 5;

interface BelowFloor {
  students: number;
  eligible: number;
  share: Ratio;
}

export interface AttendanceData {
  /** Marks, not students: present + late over every mark in the window. */
  rate: Ratio;
  daily: { date: string; rate: number | null }[];
  below: BelowFloor | null;
  notMarking: { sections: number; of: number; since: string } | null;
}

export interface AttendanceGroup {
  rate: Ratio;
  below: BelowFloor;
  notMarking: { sections: number; of: number };
}

export interface AttendanceLists {
  students: {
    fullName: string;
    className: string;
    sectionName: string;
    rate: number;
    absent: number;
  }[];
  notMarking: {
    className: string;
    sectionName: string;
    lastMarkedOn: string | null;
  }[];
}

/** Attendance (05-ATTENDANCE.md): how well each branch attends, and who needs a follow-up. */
@Injectable()
export class DirectorAttendanceService {
  constructor(
    private director: DirectorService,
    private queries: DirectorQueriesService,
    private attendance: AttendanceService,
    private audit: AuditLogService,
  ) {}

  insights(scope: DirectorScope, query: InsightsQueryDto) {
    return this.director.insights<AttendanceData, AttendanceGroup>(
      scope,
      query,
      (ctx) => this.branchAttendance(ctx),
      (rows) => this.rollUp(rows),
    );
  }

  async lists(scope: DirectorScope, query: InsightsQueryDto) {
    if (!query.branch || query.branch === 'all')
      throw new BadRequestException('Choose one branch to see names');
    const result = await this.director.insights<AttendanceLists | null, null>(
      scope,
      query,
      async ({ branch, year, range, now }) => {
        if (!year) return null;
        const [students, sections] = await Promise.all([
          this.queries.attendanceRiskList(branch.id, year.id, range),
          this.notMarkingSections(branch.id, year.id, now),
        ]);
        return {
          students: students.map((s) => ({
            fullName: s.fullName,
            className: s.className,
            sectionName: s.sectionName,
            rate: ratio(s.attended, s.total).value ?? 0,
            absent: s.absent,
          })),
          notMarking: sections.rows.slice(0, 5).map((r) => ({
            className: r.className,
            sectionName: r.sectionName,
            lastMarkedOn: r.lastMarked ? ymd(new Date(r.lastMarked)) : null,
          })),
        };
      },
      () => null,
      { oneAtATime: false },
    );
    void this.audit.record(scope.directorId, 'DIRECTOR_LIST_VIEW', {
      schoolId: query.branch,
      entityType: 'School',
      entityId: query.branch,
      metadata: { module: 'attendance' },
    });
    return result;
  }

  private async branchAttendance(ctx: BranchContext): Promise<AttendanceData> {
    const { actor, branch, year, range, now } = ctx;
    const [stats, risk, registers] = await Promise.all([
      // A custom window is allowed here (README §1, the one M13 exception); its key is per window.
      this.attendance.getSchoolStats(actor, {
        from: range.window.from,
        to: range.window.to,
      }),
      year ? this.queries.attendanceRisk(branch.id, year.id, range) : null,
      year ? this.notMarkingSections(branch.id, year.id, now) : null,
    ]);
    const marks = stats.range;
    return {
      // presentRate reads 0 with no marks; rebuilt so that shows as "no data".
      rate: ratio(marks.present + marks.late, marks.total),
      daily: stats.daily.map((d) => ({
        date: d.date,
        rate: d.total > 0 ? d.presentRate : null,
      })),
      below: risk && {
        students: risk.below,
        eligible: risk.eligible,
        share: ratio(risk.below, risk.enrolled),
      },
      notMarking: registers && {
        sections: registers.rows.length,
        of: registers.of,
        since: registers.since,
      },
    };
  }

  /** Sections with students that took no register since the 5th most recent working day. */
  private async notMarkingSections(schoolId: string, ayId: string, now: Date) {
    const [rows, workingDays] = await Promise.all([
      this.queries.sectionRegisters(schoolId, ayId, now),
      this.queries.workingDays(schoolId),
    ]);
    const since = nthWorkingDayBack(workingDays, now, UNMARKED_WORKING_DAYS);
    const stale = rows
      .filter((r) => !r.lastMarked || new Date(r.lastMarked) < since)
      // Never-marked first, then the longest silent.
      .sort(
        (a, b) =>
          (a.lastMarked ? new Date(a.lastMarked).getTime() : 0) -
          (b.lastMarked ? new Date(b.lastMarked).getTime() : 0),
      );
    return { rows: stale, of: rows.length, since: ymd(since) };
  }

  /** The rate counts every branch's marks; the session-based counts only branches with a session. */
  private rollUp(rows: BranchResult<AttendanceData>[]): AttendanceGroup {
    let attended = 0;
    let marks = 0;
    const below = { students: 0, eligible: 0, enrolled: 0 };
    const notMarking = { sections: 0, of: 0 };
    for (const { status, data } of rows) {
      if (!data) continue;
      attended += data.rate.num;
      marks += data.rate.den;
      if (status !== 'ok') continue;
      if (data.below) {
        below.students += data.below.students;
        below.eligible += data.below.eligible;
        below.enrolled += data.below.share.den;
      }
      if (data.notMarking) {
        notMarking.sections += data.notMarking.sections;
        notMarking.of += data.notMarking.of;
      }
    }
    return {
      rate: ratio(attended, marks),
      below: {
        students: below.students,
        eligible: below.eligible,
        share: ratio(below.students, below.enrolled),
      },
      notMarking,
    };
  }
}
