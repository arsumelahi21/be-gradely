import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { DirectorService, ScopeBranch } from './director.service';
import { Role } from '../common/types/role.type';

// The director reaches per-school services as that branch's principal (the pinned actor).
// These scans keep it to the read whitelist of 00 §6: a new call fails here until reviewed.
const READ_WHITELIST: Record<string, string[]> = {
  feeReports: [
    'summary',
    'collectionTrend',
    'statusBreakdown',
    'byClass',
    'outstanding',
  ],
  challans: ['coverage'],
  attendance: ['getSchoolStats'],
  timetable: ['getOverview'],
  assignments: ['getSchoolStats'],
};

const sources = readdirSync(__dirname)
  .filter(
    (f) =>
      f.startsWith('director') && f.endsWith('.ts') && !f.endsWith('.spec.ts'),
  )
  .map((f) => ({ file: f, text: readFileSync(join(__dirname, f), 'utf8') }));

describe('director pinned actor', () => {
  it('only calls whitelisted read methods on reused services', () => {
    const calls = sources.flatMap(({ file, text }) =>
      [
        ...text.matchAll(
          /this\.(feeReports|challans|attendance|timetable|assignments)\.(\w+)\(/g,
        ),
      ].map(([, service, method]) => ({ file, service, method })),
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls)
      expect(READ_WHITELIST[c.service]).toContain(c.method);
  });

  it('is built in exactly one place and is never a super admin', () => {
    const all = sources.map((s) => s.text).join('\n');
    expect(all.match(/role: Role\.SCHOOL_ADMIN/g)).toHaveLength(1);
    expect(all).not.toContain('Role.SUPER_ADMIN');
  });

  it('pins the branch taken from the scope', () => {
    const branch = { id: 'school-1' } as ScopeBranch;
    const actor = (new DirectorService(null as never) as any).pinnedActor(
      'director-1',
      branch,
    );
    expect(actor).toEqual({
      userId: 'director-1',
      role: Role.SCHOOL_ADMIN,
      schoolId: 'school-1',
    });
  });
});
