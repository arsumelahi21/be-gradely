import {
  schoolCacheEntityForRole,
  schoolCacheKey,
  schoolCachePrefix,
} from './school-cache';

// The prefix is the contract: cachedSchoolList writes under it, every write path (incl. users.service)
// wipes by it — if these drift, writes stop invalidating reads.
describe('school-cache keys', () => {
  it('a key always starts with its entity prefix (so delByPrefix wipes it)', () => {
    const prefix = schoolCachePrefix('sch1', 'students');
    expect(prefix).toBe('school:sch1:students:');
    expect(schoolCacheKey('sch1', 'students', { page: 2 })).toContain(prefix);
    expect(schoolCacheKey('sch1', 'students')).toBe('school:sch1:students:all');
  });

  it('serializes object variants stably', () => {
    expect(schoolCacheKey('s', 'subjects', { page: 1, search: null })).toBe(
      'school:s:subjects:{"page":1,"search":null}',
    );
  });

  it('maps only STUDENT/TEACHER roles to a cached list', () => {
    expect(schoolCacheEntityForRole('STUDENT')).toBe('students');
    expect(schoolCacheEntityForRole('TEACHER')).toBe('teachers');
    expect(schoolCacheEntityForRole('PARENT')).toBeNull();
    expect(schoolCacheEntityForRole('SCHOOL_ADMIN')).toBeNull();
  });
});
