import { Injectable } from '@nestjs/common';
import {
  BranchContext,
  BranchResult,
  DirectorScope,
  DirectorService,
} from './director.service';
import { DirectorQueriesService } from './director.queries';
import { InsightsQueryDto } from './dto/insights-query.dto';
import { Ratio, ratio } from './insights';

/** Signed in at least once in the window, of the role's active accounts. */
export interface ActivityData {
  teachers: Ratio;
  parents: Ratio;
  students: Ratio;
}

export type ActivityGroup = ActivityData;

const ROLES = {
  TEACHER: 'teachers',
  PARENT: 'parents',
  STUDENT: 'students',
} as const;

/** Activity (09-COMMUNICATION-ACTIVITY.md, adoption only): is each branch actually using Gradely. */
@Injectable()
export class DirectorActivityService {
  constructor(
    private director: DirectorService,
    private queries: DirectorQueriesService,
  ) {}

  insights(scope: DirectorScope, query: InsightsQueryDto) {
    return this.director.insights<ActivityData, ActivityGroup>(
      scope,
      query,
      (ctx) => this.branchActivity(ctx),
      (rows) => this.rollUp(rows),
    );
  }

  private async branchActivity({
    branch,
    range,
  }: BranchContext): Promise<ActivityData> {
    const rows = await this.queries.adoption(branch.id, range);
    const data: ActivityData = {
      teachers: ratio(0, 0),
      parents: ratio(0, 0),
      students: ratio(0, 0),
    };
    for (const r of rows) {
      const key = ROLES[r.role as keyof typeof ROLES];
      if (key) data[key] = ratio(r.signedIn, r.active);
    }
    return data;
  }

  /** A sign-in count needs no session, so every branch counts (00 §5.6). */
  private rollUp(rows: BranchResult<ActivityData>[]): ActivityGroup {
    const sum = (key: keyof ActivityData) =>
      ratio(
        rows.reduce((s, r) => s + (r.data?.[key].num ?? 0), 0),
        rows.reduce((s, r) => s + (r.data?.[key].den ?? 0), 0),
      );
    return {
      teachers: sum('teachers'),
      parents: sum('parents'),
      students: sum('students'),
    };
  }
}
